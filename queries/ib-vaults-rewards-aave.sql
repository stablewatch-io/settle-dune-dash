-- IB Vaults Rewards Calculation (AAVE)
-- Query ID: 6860002
-- Description: Time-weighted USDS reward per depositor for the AAVE USDS IB vault.
--              1 aToken = 1 USDS, so no share price conversion is needed.
--              No idle_factor applied — AAVE capital is treated as fully productive.
--
-- Vault (fixed):
--   AAVE USDS aToken: 0x32a6268f9ba3642dda7892add74f1d34469a4259
--
-- Parameters:
--   {{from_timestamp}}  — Period start (e.g., '2026-03-10 16:00:00')
--   {{to_timestamp}}    — Period end   (e.g., '2026-03-17 15:59:59')
--
-- reward = SUM over segments of:
--   (balance_atokens / 1e18) * apr * segment_seconds / seconds_per_year
--
-- Reads from:
--   query_6852397  ib-vaults-raw → Transfer events (includes AAVE aToken)
--   query_6853959  ib-vaults-ssr → SSR history (basis points) from SPBEAM contract
--   ethereum.blocks              → Block lookup by timestamp (for dynamic block resolution)
--

WITH

-- ─── Parameters (edit here to change period) ──────────────────────────────────
params AS (
    SELECT
        -- AAVE USDS aToken (fixed — only one AAVE vault tracked)
        0x32a6268f9ba3642dda7892add74f1d34469a4259   AS vault,
        -- Period timestamps (main parameters to adjust)
        CAST('{{from_timestamp}}' AS TIMESTAMP)                       AS from_ts_param,
        CAST('{{to_timestamp}}' AS TIMESTAMP)                         AS to_ts_param,
        -- Calculate unix timestamps
        CAST(to_unixtime(CAST('{{from_timestamp}}' AS TIMESTAMP)) AS DOUBLE) AS from_block_ts,
        CAST(to_unixtime(CAST('{{to_timestamp}}' AS TIMESTAMP)) AS DOUBLE)   AS to_block_ts,
        -- Lookup blocks from timestamps
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
        -- No avg_share_price: 1 aToken = 1 USDS.
        -- No idle_factor: AAVE is treated as fully productive (factor = 1).
        CAST(31557600.0 AS DOUBLE)                                    AS seconds_per_year, -- 365.25 * 24 * 3600
        '0x0000000000000000000000000000000000000000'                  AS zero_addr,
        '0x000000000000000000000000000000000000dead'                  AS dead_addr
),

-- ─── APR lookup ───────────────────────────────────────────────────────────────
-- APR sourced from SPBEAM Set(SSR) events via query_6853959 (ib-vaults-ssr).
-- We take the SSR in effect at from_block and use it as a constant for the
-- entire period. This is a simplification: if the SSR changed mid-period,
-- a more accurate calculation would apply each rate only to its active window.
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

-- ─── All Transfer events from ib-vaults-raw (query_6852397) ──────────────────
-- Filtered to the AAVE aToken and up through period end.
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
timeline AS (
    SELECT
        pb.address,
        p.from_block_ts                                               AS event_ts,
        0                                                             AS block_number,
        -1                                                            AS log_index,
        pb.balance_shares                                             AS delta_shares,
        'period_start'                                                AS event_type
    FROM pre_balances pb CROSS JOIN params_with_apr p

    UNION ALL

    SELECT address, event_ts, block_number, log_index, delta_shares, event_type
    FROM in_period_deltas
),

-- ─── Running balance after each event, plus the start of the next segment ─────
running AS (
    SELECT
        address,
        event_type,
        event_ts,
        block_number,
        log_index,
        SUM(delta_shares) OVER (
            PARTITION BY address
            ORDER BY event_ts, block_number, log_index
            ROWS UNBOUNDED PRECEDING
        )                                                             AS balance_after,
        LEAD(event_ts) OVER (
            PARTITION BY address
            ORDER BY event_ts, block_number, log_index
        )                                                             AS next_event_ts
    FROM timeline
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
-- balance_after is in raw aToken units (1e18 scale) ≈ USDS (1 aToken = 1 USDS).
-- No share price multiplication or idle_factor.
-- Result is in human-readable USDS so that reward_wei = SUM * 1e18.
segments AS (
    SELECT
        r.address,
        r.balance_after,
        (r.balance_after / 1e18)
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
    COALESCE(pb.balance_shares, 0)                                    AS initial_balance_shares,
    fb.final_balance_shares,
    fb.final_balance_shares / 1e18                                    AS final_balance_usds,
    COALESCE(st.total_deposited_shares, 0)                            AS total_deposited_shares,
    COALESCE(st.total_withdrawn_shares, 0)                            AS total_withdrawn_shares,
    COALESCE(st.deposit_count,  0)                                    AS deposit_count,
    COALESCE(st.withdraw_count, 0)                                    AS withdraw_count
FROM segments s
CROSS JOIN params_with_apr p
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
    st.withdraw_count
ORDER BY reward_usds DESC
