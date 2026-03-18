-- IB Vaults Rewards Calculation
-- Query ID: 6852356
-- Description: Time-weighted USDS reward per depositor for IB vaults.
--              Vault selectable via dropdown. 1 week period. Reproduces calculate_rewards.py output.
--
-- Vaults:
--   Morpho USDS Risk Capital (Skybase IB, Morpho v2): 0xf42bca228d9bd3e2f8ee65fec3d21de1063882d4
--   Morpho USDS Flagship     (Skybase IB, Morpho v2): 0xe15fcc81118895b67b6647bbd393182df44e11e0
--   USDS Vault               (Spark, Morpho v1):      0xe41a0583334f0dc4e023acd0bfef3667f6fe0597
--
-- reward = SUM over segments of:
--   (balance_shares / 1e18) * avg_share_price * idle_factor * apr * segment_seconds / seconds_per_year
--
-- Reads from:
--   query_6852397  ib-vaults-raw        → Transfer events for all vaults
--   query_6852700  ib-vaults-share-price → Hourly totalAssets/totalSupply per vault
--   query_6853959  ib-vaults-ssr        → SSR history (basis points) from SPBEAM contract

WITH

-- ─── Parameters (edit here to change vault/period) ────────────────────────────
params AS (
    SELECT
        -- Vault — select from the dropdown above the query
        {{vault_address}}                                             AS vault,
        -- Period
        24628168                                                      AS from_block,
        CAST(1773159011 AS DOUBLE)                                    AS from_block_ts,   -- 2026-03-10 16:00:59 UTC
        24678301                                                      AS to_block,
        CAST(1773763667 AS DOUBLE)                                    AS to_block_ts,     -- 2026-03-17 15:59:59 UTC
        -- avg_share_price: (price_at_start + price_at_end) / 2, matching extract_events.py.
        -- Sourced from ib-vaults-share-price (query_6852700); hours chosen to bracket the period.
        (
            SELECT AVG(share_price)
            FROM query_6852700
            WHERE vault_address = '{{vault_address}}'
              AND hour IN (TIMESTAMP '2026-03-10 16:00:00', TIMESTAMP '2026-03-17 15:00:00')
        )                                                             AS avg_share_price,
        -- Reward parameters
        CAST(0.80 AS DOUBLE)                                          AS idle_factor,
        -- APR sourced from SPBEAM Set(SSR) events via query_6853959 (ib-vaults-ssr).
        -- We take the SSR in effect at from_block and use it as a constant for the
        -- entire period. This is a simplification: if the SSR changed mid-period,
        -- a more accurate calculation would apply each rate only to its active window.
        (
            SELECT apr
            FROM query_6853959
            WHERE block_number <= 24628168
            ORDER BY block_number DESC
            LIMIT 1
        )                                                             AS apr,
        CAST(31557600.0 AS DOUBLE)                                    AS seconds_per_year, -- 365.25 * 24 * 3600
        '0x0000000000000000000000000000000000000000'                  AS zero_addr,
        '0x000000000000000000000000000000000000dead'                  AS dead_addr
),

-- ─── All Transfer events from ib-vaults-raw (query_6852397) ──────────────────
-- Filtered to this vault and up through period end.
all_transfers AS (
    SELECT
        block_number,
        to_unixtime(block_time)                                       AS event_ts,
        log_index,
        CAST(shares_raw AS DOUBLE)                                    AS shares,
        from_address                                                  AS from_addr,
        to_address                                                    AS to_addr
    FROM query_6852397
    CROSS JOIN params
    WHERE vault_address = params.vault
      AND block_number  <= params.to_block
),

-- ─── Pre-period balance per address ──────────────────────────────────────────
pre_period_deltas AS (
    SELECT to_addr AS address, shares AS delta
    FROM all_transfers CROSS JOIN params
    WHERE block_number < params.from_block

    UNION ALL

    SELECT from_addr AS address, -shares AS delta
    FROM all_transfers CROSS JOIN params
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
            WHEN from_addr = (SELECT zero_addr FROM params) THEN 'deposit'
            ELSE 'transfer_in'
        END                                                           AS event_type
    FROM all_transfers CROSS JOIN params
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
            WHEN to_addr = (SELECT zero_addr FROM params) THEN 'withdraw'
            ELSE 'transfer_out'
        END                                                           AS event_type
    FROM all_transfers CROSS JOIN params
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
    FROM pre_balances pb CROSS JOIN params p

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
-- balance_after is in raw share units (1e18 scale); divide by 1e18 to get
-- human-readable shares, then multiply by avg_share_price to get USDS.
-- Result is in human-readable USDS so that reward_wei = SUM * 1e18.
segments AS (
    SELECT
        r.address,
        r.balance_after,
        (r.balance_after / 1e18)
            * p.avg_share_price
            * p.idle_factor
            * p.apr
            * (COALESCE(r.next_event_ts, p.to_block_ts) - r.event_ts)
            / p.seconds_per_year                                      AS segment_reward_usds
    FROM running r
    CROSS JOIN params p
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
    fb.final_balance_shares * p.avg_share_price / 1e18                AS final_balance_usds,
    COALESCE(st.total_deposited_shares, 0)                            AS total_deposited_shares,
    COALESCE(st.total_withdrawn_shares, 0)                            AS total_withdrawn_shares,
    COALESCE(st.deposit_count,  0)                                    AS deposit_count,
    COALESCE(st.withdraw_count, 0)                                    AS withdraw_count
FROM segments s
CROSS JOIN params p
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
    p.avg_share_price
ORDER BY reward_usds DESC
