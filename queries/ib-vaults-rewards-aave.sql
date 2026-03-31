-- IB Vaults Rewards Calculation (AAVE)
-- Query ID: 6860002
-- Description: Time-weighted USDS reward for the AAVE USDS IB vault (vault level).
--              Tracks the underlying USDS balance held by the aToken contract via
--              ERC20 Transfer events. No aToken balance or rebasing balance used.lly productive.
--
-- Vault (fixed):
--   AAVE USDS aToken contract: 0x32a6268f9ba3642dda7892add74f1d34469a4259
--   Underlying USDS token:     0xdc035d45d973e3ec169d2276ddab16f1e407384f
--
-- Parameters:
--   {{from_timestamp}}  — Period start (e.g., '2026-03-10 16:00:00')
--   {{to_timestamp}}    — Period end   (e.g., '2026-03-17 15:59:59')
--
-- reward = SUM over segments of:
--   usds_balance * apr * segment_seconds / seconds_per_year
--
-- Reads from:
--   query_6853959  ib-vaults-ssr → SSR history (basis points) from SPBEAM contract
--   ethereum.logs               → USDS ERC20 Transfer events
--   ethereum.blocks             → Block lookup by timestamp (for dynamic block resolution)
--

WITH

-- ─── Parameters ───────────────────────────────────────────────────────────────
params AS (
    SELECT
        0x32a6268f9ba3642dda7892add74f1d34469a4259   AS vault,
        0xdc035d45d973e3ec169d2276ddab16f1e407384f   AS usds,
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
        CAST(31557600.0 AS DOUBLE)                                    AS seconds_per_year -- 365.25 * 24 * 3600
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

-- ─── USDS transfers to/from the aToken contract ───────────────────────────────
-- Signed delta: positive when USDS flows into the vault, negative when it flows out.
usds_deltas AS (
    SELECT
        block_number,
        index                                                         AS log_index,
        CAST(to_unixtime(block_time) AS DOUBLE)                       AS event_ts,
        CASE
            WHEN bytearray_substring(topic2, 13) = params.vault
            THEN  CAST(bytearray_to_uint256(data) AS DOUBLE) / 1e18
            ELSE -CAST(bytearray_to_uint256(data) AS DOUBLE) / 1e18
        END                                                           AS delta_usds
    FROM ethereum.logs
    CROSS JOIN params_with_apr params
    WHERE contract_address = params.usds
      AND topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
      AND (
          bytearray_substring(topic1, 13) = params.vault
          OR bytearray_substring(topic2, 13) = params.vault
      )
      AND block_number <= params.to_block
),

-- ─── Running vault-level USDS balance at each event ──────────────────────────
usds_balance_series AS (
    SELECT
        block_number,
        log_index,
        event_ts,
        SUM(delta_usds) OVER (
            ORDER BY block_number, log_index
            ROWS UNBOUNDED PRECEDING
        )                                                             AS usds_balance
    FROM usds_deltas
),

-- ─── Balance just before the period starts ────────────────────────────────────
pre_balance AS (
    SELECT usds_balance
    FROM usds_balance_series
    CROSS JOIN params_with_apr params
    WHERE block_number < params.from_block
    ORDER BY block_number DESC, log_index DESC
    LIMIT 1
),

-- ─── In-period balance snapshots ──────────────────────────────────────────────
in_period AS (
    SELECT block_number, log_index, event_ts, usds_balance
    FROM usds_balance_series
    CROSS JOIN params_with_apr params
    WHERE block_number >= params.from_block
),

-- ─── Timeline: synthetic period-start row + real in-period events ─────────────
timeline AS (
    SELECT
        p.from_block_ts                                               AS event_ts,
        0                                                             AS block_number,
        -1                                                            AS log_index,
        COALESCE(pb.usds_balance, 0)                                  AS usds_balance
    FROM params_with_apr p
    LEFT JOIN pre_balance pb ON 1 = 1

    UNION ALL

    SELECT event_ts, block_number, log_index, usds_balance
    FROM in_period
),

-- ─── Each segment: [event_ts, next_event_ts) with a fixed usds_balance ─────────
running AS (
    SELECT
        event_ts,
        block_number,
        log_index,
        usds_balance,
        LEAD(event_ts) OVER (
            ORDER BY event_ts, block_number, log_index
        )                                                             AS next_event_ts
    FROM timeline
),

-- ─── Reward per segment ───────────────────────────────────────────────────────
segments AS (
    SELECT
        r.usds_balance
            * p.apr
            * (COALESCE(r.next_event_ts, p.to_block_ts) - r.event_ts)
            / p.seconds_per_year                                      AS segment_reward_usds
    FROM running r
    CROSS JOIN params_with_apr p
    WHERE r.usds_balance > 0
      AND COALESCE(r.next_event_ts, p.to_block_ts) > r.event_ts
),

-- ─── Final vault USDS balance (last snapshot at or before period end) ──────────
final_balance AS (
    SELECT usds_balance AS final_usds_balance
    FROM usds_balance_series
    CROSS JOIN params_with_apr params
    WHERE block_number <= params.to_block
    ORDER BY block_number DESC, log_index DESC
    LIMIT 1
)

-- ─── Final output ─────────────────────────────────────────────────────────────
SELECT
    SUM(s.segment_reward_usds)                                        AS reward_usds,
    CAST(SUM(s.segment_reward_usds) * 1e18 AS DECIMAL(38, 0))         AS reward_wei,
    COALESCE(MAX(pb.usds_balance), 0)                                 AS initial_usds_balance,
    COALESCE(MAX(fb.final_usds_balance), 0)                           AS final_usds_balance
FROM segments s
LEFT JOIN pre_balance  pb ON 1 = 1
LEFT JOIN final_balance fb ON 1 = 1
