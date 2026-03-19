-- IB Vaults Rewards Calculation (Curve stUSDS/USDS)
-- Query ID: 6864537
-- Description: Time-weighted USDS reward per depositor for the Curve stUSDS/USDS IB vault.
--              LP tokens are converted to USDS using the coins(0)/totalSupply ratio
--              at each segment boundary, reconstructed on-chain from Transfer events.
--              No idle_factor applied — Curve capital is treated as fully productive.
--
-- Pool (fixed):
--   LP token:  0x2c7c98a3b1582d83c43987202aeff638312478ae  (Curve stUSDS/USDS LP)
--   coins(0):  0xdc035d45d973e3ec169d2276ddab16f1e407384f  (USDS — reward-bearing token)
--   coins(1):  0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9  (stUSDS)
--
-- Parameters:
--   {{from_timestamp}}  — Period start (e.g., '2026-03-10 16:00:00')
--   {{to_timestamp}}    — Period end   (e.g., '2026-03-17 15:59:59')
--
-- reward = SUM over segments of:
--   (lp_balance / 1e18) * coins0_per_lp_at_segment * apr * segment_seconds / seconds_per_year
--
-- Reads from:
--   query_6852397  ib-vaults-raw → LP token Transfer events
--   query_6853959  ib-vaults-ssr → SSR history (basis points) from SPBEAM contract
--   ethereum.logs                → USDS (coins(0)) transfers to/from pool (direct query)
--   ethereum.blocks              → Block lookup by timestamp (for dynamic block resolution)
--
-- NOTE: Calculation CTEs are intentionally duplicated from ib-vaults-rewards-morpho/aave.
--       Dune SQL has no UDF/macro support; shared raw data (query_6852397, query_6853959)
--       is the extent of practical abstraction possible.

WITH

-- ─── Parameters ───────────────────────────────────────────────────────────────
params AS (
    SELECT
        0x2c7c98a3b1582d83c43987202aeff638312478ae AS vault,
        0xdc035d45d973e3ec169d2276ddab16f1e407384f AS coins0,
        CAST('{{from_timestamp}}' AS TIMESTAMP)                       AS from_ts_param,
        CAST('{{to_timestamp}}' AS TIMESTAMP)                         AS to_ts_param,
        CAST(to_unixtime(CAST('{{from_timestamp}}' AS TIMESTAMP)) AS DOUBLE) AS from_block_ts,
        CAST(to_unixtime(CAST('{{to_timestamp}}' AS TIMESTAMP)) AS DOUBLE)   AS to_block_ts,
        (
            SELECT number
            FROM ethereum.blocks
            WHERE time >= CAST('{{from_timestamp}}' AS TIMESTAMP)
            ORDER BY time ASC
            LIMIT 1
        )                                                             AS from_block,
        (
            SELECT number
            FROM ethereum.blocks
            WHERE time <= CAST('{{to_timestamp}}' AS TIMESTAMP)
            ORDER BY time DESC
            LIMIT 1
        )                                                             AS to_block,
        CAST(31557600.0 AS DOUBLE)                                    AS seconds_per_year,
        '0x0000000000000000000000000000000000000000'                  AS zero_addr,
        '0x000000000000000000000000000000000000dead'                  AS dead_addr
),

-- ─── APR lookup ───────────────────────────────────────────────────────────────
ssr_with_rank AS (
    SELECT
        block_number,
        apr,
        ROW_NUMBER() OVER (ORDER BY block_number DESC) AS rn
    FROM query_6853959
    CROSS JOIN params
    WHERE block_number <= params.from_block
),

params_with_apr AS (
    SELECT
        p.*,
        (SELECT apr FROM ssr_with_rank WHERE rn = 1)                  AS apr
    FROM params p
),

-- ─── Pool ratio time series ──────────────────────────────────────────────────
-- Reconstruct coins(0) balance and LP supply at every on-chain event, then
-- derive coins0_per_lp. This is merged with the user timeline later so each
-- reward segment uses the exact ratio at its start block.
--
-- coins0_deltas: every USDS transfer to/from the pool as a signed delta.
coins0_deltas AS (
    SELECT
        block_number,
        index                                                         AS log_index,
        CASE
            WHEN bytearray_substring(topic2, 13) = params.vault
            THEN CAST(bytearray_to_uint256(data) AS DOUBLE) / 1e18
            ELSE -CAST(bytearray_to_uint256(data) AS DOUBLE) / 1e18
        END                                                           AS delta_coins0
    FROM ethereum.logs
    CROSS JOIN params_with_apr params
    WHERE contract_address = params.coins0
      AND topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
      AND (
          bytearray_substring(topic1, 13) = params.vault
          OR bytearray_substring(topic2, 13) = params.vault
      )
      AND block_number <= params.to_block
),

-- lp_supply_deltas: every LP mint/burn as a signed delta.
lp_supply_deltas AS (
    SELECT
        block_number,
        log_index,
        CASE
            WHEN event_type = 'deposit'  THEN  shares
            WHEN event_type = 'withdraw' THEN -shares
        END                                                           AS delta_lp
    FROM query_6852397
    CROSS JOIN params_with_apr params
    WHERE vault_address = params.vault
      AND event_type IN ('deposit', 'withdraw')
      AND block_number <= params.to_block
),

-- Merge both event streams and compute running totals.
pool_ratio_series AS (
    SELECT
        block_number,
        log_index,
        SUM(delta_coins0) OVER w                                      AS coins0,
        SUM(delta_lp)     OVER w                                      AS lp_supply
    FROM (
        SELECT block_number, log_index, delta_coins0, 0.0 AS delta_lp
        FROM coins0_deltas
        UNION ALL
        SELECT block_number, log_index, 0.0 AS delta_coins0, delta_lp
        FROM lp_supply_deltas
    ) combined
    WINDOW w AS (ORDER BY block_number, log_index ROWS UNBOUNDED PRECEDING)
),

-- ─── Ratio at period end (for final_balance_usds display) ────────────────────
end_ratio AS (
    SELECT coins0 / NULLIF(lp_supply, 0)                              AS coins0_per_lp
    FROM pool_ratio_series
    ORDER BY block_number DESC, log_index DESC
    LIMIT 1
),

-- ─── All LP Transfer events from ib-vaults-raw (query_6852397) ───────────────
all_transfers AS (
    SELECT
        block_number,
        to_unixtime(block_time)                                       AS event_ts,
        log_index,
        CAST(shares_raw AS DOUBLE)                                    AS shares,
        from_address                                                  AS from_addr,
        to_address                                                    AS to_addr
    FROM query_6852397
    CROSS JOIN params_with_apr params
    WHERE vault_address = params.vault
      AND block_number  <= params.to_block
),

-- ─── Pre-period balance per address ──────────────────────────────────────────
pre_period_deltas AS (
    SELECT to_addr AS address, shares AS delta
    FROM all_transfers CROSS JOIN params_with_apr params
    WHERE block_number < params.from_block

    UNION ALL

    SELECT from_addr AS address, -shares AS delta
    FROM all_transfers CROSS JOIN params_with_apr params
    WHERE block_number < params.from_block
      AND from_addr != params.zero_addr
),

pre_balances AS (
    SELECT address, SUM(delta) AS balance_shares
    FROM pre_period_deltas
    GROUP BY address
    HAVING SUM(delta) > 0
),

-- ─── In-period events expanded into per-address delta rows ───────────────────
in_period_deltas AS (
    SELECT
        to_addr                                                       AS address,
        shares                                                        AS delta_shares,
        event_ts,
        block_number,
        log_index,
        CASE
            WHEN from_addr = (SELECT zero_addr FROM params_with_apr) THEN 'deposit'
            ELSE 'transfer_in'
        END                                                           AS event_type
    FROM all_transfers CROSS JOIN params_with_apr params
    WHERE block_number >= params.from_block
      AND event_ts     <= params.to_block_ts
      AND to_addr      != params.zero_addr

    UNION ALL

    SELECT
        from_addr                                                     AS address,
        -shares                                                       AS delta_shares,
        event_ts,
        block_number,
        log_index,
        CASE
            WHEN to_addr = (SELECT zero_addr FROM params_with_apr) THEN 'withdraw'
            ELSE 'transfer_out'
        END                                                           AS event_type
    FROM all_transfers CROSS JOIN params_with_apr params
    WHERE block_number >= params.from_block
      AND event_ts     <= params.to_block_ts
      AND from_addr    != params.zero_addr
),

-- ─── Timeline: synthetic period-start row + real in-period events ─────────────
-- period_start uses from_block (not 0) so it sorts correctly when merged with
-- pool_ratio_series for the forward-fill below.
timeline AS (
    SELECT
        pb.address,
        p.from_block_ts                                               AS event_ts,
        CAST(p.from_block AS BIGINT)                                  AS block_number,
        -1                                                            AS log_index,
        pb.balance_shares                                             AS delta_shares,
        'period_start'                                                AS event_type
    FROM pre_balances pb CROSS JOIN params_with_apr p

    UNION ALL

    SELECT address, event_ts, block_number, log_index, delta_shares, event_type
    FROM in_period_deltas
),

-- ─── Merge pool ratio events with user timeline and forward-fill ─────────────
-- Pool events carry the ratio; user events carry address/delta. After ordering
-- globally by (block_number, log_index), LAST_VALUE IGNORE NULLS propagates the
-- most recent ratio onto each user event.
merged_events AS (
    SELECT
        CAST(NULL AS VARCHAR)                                         AS address,
        CAST(NULL AS DOUBLE)                                          AS event_ts,
        block_number,
        log_index,
        0.0                                                           AS delta_shares,
        'pool_ratio'                                                  AS event_type,
        coins0 / NULLIF(lp_supply, 0)                                 AS ratio
    FROM pool_ratio_series

    UNION ALL

    SELECT
        address,
        event_ts,
        block_number,
        log_index,
        delta_shares,
        event_type,
        CAST(NULL AS DOUBLE)                                          AS ratio
    FROM timeline
),

merged_with_ratio AS (
    SELECT
        address,
        event_ts,
        block_number,
        log_index,
        delta_shares,
        event_type,
        LAST_VALUE(ratio) IGNORE NULLS OVER (
            ORDER BY block_number, log_index
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        )                                                             AS coins0_per_lp
    FROM merged_events
),

-- Filter to user events only (pool_ratio rows served their purpose).
timeline_with_ratio AS (
    SELECT * FROM merged_with_ratio WHERE address IS NOT NULL
),

-- ─── Running balance after each event, plus the start of the next segment ─────
running AS (
    SELECT
        address,
        event_type,
        event_ts,
        block_number,
        log_index,
        coins0_per_lp,
        SUM(delta_shares) OVER (
            PARTITION BY address
            ORDER BY event_ts, block_number, log_index
            ROWS UNBOUNDED PRECEDING
        )                                                             AS balance_after,
        LEAD(event_ts) OVER (
            PARTITION BY address
            ORDER BY event_ts, block_number, log_index
        )                                                             AS next_event_ts
    FROM timeline_with_ratio
),

-- ─── Final balance per address (last running balance row) ─────────────────────
final_balances AS (
    SELECT address, balance_after AS final_balance_shares
    FROM (
        SELECT
            address,
            balance_after,
            ROW_NUMBER() OVER (
                PARTITION BY address
                ORDER BY event_ts DESC, block_number DESC, log_index DESC
            ) AS rn
        FROM running
    )
    WHERE rn = 1
),

-- ─── Reward per segment ───────────────────────────────────────────────────────
-- Each segment uses the coins0_per_lp ratio in effect at that segment's start
-- block, not a period-wide average. No idle_factor.
segments AS (
    SELECT
        r.address,
        r.balance_after,
        (r.balance_after / 1e18)
            * r.coins0_per_lp
            * p.apr
            * (COALESCE(r.next_event_ts, p.to_block_ts) - r.event_ts)
            / p.seconds_per_year                                      AS segment_reward_usds
    FROM running r
    CROSS JOIN params_with_apr p
    WHERE r.balance_after > 0
      AND COALESCE(r.next_event_ts, p.to_block_ts) > r.event_ts
      AND r.address != p.dead_addr
),

-- ─── Per-address event stats ──────────────────────────────────────────────────
addr_stats AS (
    SELECT
        address,
        SUM(CASE WHEN event_type = 'deposit'  THEN delta_shares  ELSE 0 END) AS total_deposited_shares,
        SUM(CASE WHEN event_type = 'withdraw' THEN -delta_shares ELSE 0 END) AS total_withdrawn_shares,
        COUNT(CASE WHEN event_type = 'deposit'  THEN 1 END)                  AS deposit_count,
        COUNT(CASE WHEN event_type = 'withdraw' THEN 1 END)                  AS withdraw_count
    FROM in_period_deltas
    GROUP BY address
)

-- ─── Final output ─────────────────────────────────────────────────────────────
SELECT
    s.address                                                         AS depositor,
    SUM(s.segment_reward_usds)                                        AS reward_usds,
    CAST(SUM(s.segment_reward_usds) * 1e18 AS DECIMAL(38, 0))         AS reward_wei,
    COALESCE(pb.balance_shares, 0)                                    AS initial_balance_lp,
    fb.final_balance_shares                                           AS final_balance_lp,
    fb.final_balance_shares / 1e18 * er.coins0_per_lp                 AS final_balance_usds,
    COALESCE(st.total_deposited_shares, 0)                            AS total_deposited_lp,
    COALESCE(st.total_withdrawn_shares, 0)                            AS total_withdrawn_lp,
    COALESCE(st.deposit_count,  0)                                    AS deposit_count,
    COALESCE(st.withdraw_count, 0)                                    AS withdraw_count
FROM segments s
CROSS JOIN params_with_apr p
CROSS JOIN end_ratio er
LEFT JOIN pre_balances pb ON pb.address = s.address
LEFT JOIN final_balances fb ON fb.address = s.address
LEFT JOIN addr_stats     st ON st.address = s.address
GROUP BY
    s.address,
    pb.balance_shares,
    fb.final_balance_shares,
    st.total_deposited_shares,
    st.total_withdrawn_shares,
    st.deposit_count,
    st.withdraw_count,
    er.coins0_per_lp
ORDER BY reward_usds DESC
