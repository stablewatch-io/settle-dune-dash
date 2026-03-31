-- IB Vaults Rewards Calculation (Morpho) — V2 (dynamic market discovery)
-- Query ID: 6904585
-- Dune: https://dune.com/queries/6904585
-- Description: Time-weighted USDS reward for Morpho IB vaults (vault level).
--              Total idle USDS = vault/adapter cash balance + adapter's pro-rata
--              share of unborrowed USDS across all markets.
--              Markets are discovered dynamically from historical supply events;
--              no hardcoded market IDs required.
--
-- Vaults (select via {{vault_address}}):
--   Morpho USDS Flagship:      0xe15fcc81118895b67b6647bbd393182df44e11e0
--   Morpho USDS Risk Capital:  0xf42bca228d9bd3e2f8ee65fec3d21de1063882d4
--
-- Parameters:
--   {{vault_address}}   — Vault address
--   {{from_timestamp}}  — Period start (e.g., '2026-03-16 00:00:00')
--   {{to_timestamp}}    — Period end   (e.g., '2026-03-22 23:59:59')
--
-- Reads from:
--   morpho_blue_ethereum.morphoblue_evt_supply/withdraw/borrow/repay
--   ethereum.logs (USDS transfers), ethereum.blocks
--   query_6853959  ib-vaults-ssr → SSR history
--
-- NOTE: Adapter address is still hardcoded per vault (CASE mapping in params).
--       V2→V1 adapter path (MorphoVaultV1Adapter) not yet handled.

WITH

-- ─── Parameters ─────────────────────────────────────────────────────────────
params AS (
    SELECT
        {{vault_address}}                                             AS vault,
        0xdc035d45d973e3ec169d2276ddab16f1e407384f                    AS usds_token,
        CASE {{vault_address}}
            WHEN 0xe15fcc81118895b67b6647bbd393182df44e11e0
            THEN 0xf94be39e8863183ff41194b5923627c90a34039d
            WHEN 0xf42bca228d9bd3e2f8ee65fec3d21de1063882d4
            THEN 0xaaf8bf4b6e8ccb74b7f5e96d4a27ff967c1eef74
        END                                                           AS adapter,
        CAST(to_unixtime(CAST('{{from_timestamp}}' AS TIMESTAMP)) AS DOUBLE) AS from_ts,
        CAST(to_unixtime(CAST('{{to_timestamp}}' AS TIMESTAMP)) AS DOUBLE)   AS to_ts,
        (SELECT number FROM ethereum.blocks
         WHERE time >= CAST('{{from_timestamp}}' AS TIMESTAMP) ORDER BY time ASC LIMIT 1) AS from_block,
        (SELECT number FROM ethereum.blocks
         WHERE time <= CAST('{{to_timestamp}}' AS TIMESTAMP) ORDER BY time DESC LIMIT 1)  AS to_block,
        CAST(31557600.0 AS DOUBLE)                                    AS seconds_per_year
),

-- ─── APR lookup ─────────────────────────────────────────────────────────────
ssr_with_rank AS (
    SELECT apr, ROW_NUMBER() OVER (ORDER BY block_number DESC) AS rn
    FROM query_6853959 CROSS JOIN params
    WHERE block_number <= params.from_block
),

params_with_apr AS (
    SELECT p.*, (SELECT apr FROM ssr_with_rank WHERE rn = 1) AS apr
    FROM params p
),

-- ─── Dynamic market discovery ────────────────────────────────────────────────
-- All Morpho Blue markets where the adapter has ever supplied (onBehalf = adapter).
-- Replaces the hardcoded vault_markets VALUES table.
adapter_markets AS (
    SELECT DISTINCT s.id AS market_id
    FROM morpho_blue_ethereum.morphoblue_evt_supply s
    CROSS JOIN params p
    WHERE s.onBehalf = p.adapter
),

-- ─── Per-market running state: idle USDS and share ratios ───────────────────
market_events AS (
    SELECT s.evt_block_number AS block_number, s.evt_index AS log_index, s.id AS market_id,
        CAST(s.assets AS DECIMAL(38,0)) AS delta_idle,
        CAST(s.shares AS DECIMAL(38,0)) AS delta_total_shares,
        CASE WHEN s.onBehalf = p.adapter
             THEN CAST(s.shares AS DECIMAL(38,0))
             ELSE CAST(0 AS DECIMAL(38,0)) END AS delta_adapter_shares
    FROM morpho_blue_ethereum.morphoblue_evt_supply s CROSS JOIN params p
    WHERE s.id IN (SELECT market_id FROM adapter_markets)
    UNION ALL
    SELECT w.evt_block_number, w.evt_index, w.id,
        -CAST(w.assets AS DECIMAL(38,0)), -CAST(w.shares AS DECIMAL(38,0)),
        CASE WHEN w.onBehalf = p.adapter
             THEN -CAST(w.shares AS DECIMAL(38,0))
             ELSE CAST(0 AS DECIMAL(38,0)) END
    FROM morpho_blue_ethereum.morphoblue_evt_withdraw w CROSS JOIN params p
    WHERE w.id IN (SELECT market_id FROM adapter_markets)
    UNION ALL
    SELECT b.evt_block_number, b.evt_index, b.id,
        -CAST(b.assets AS DECIMAL(38,0)), CAST(0 AS DECIMAL(38,0)), CAST(0 AS DECIMAL(38,0))
    FROM morpho_blue_ethereum.morphoblue_evt_borrow b
    WHERE b.id IN (SELECT market_id FROM adapter_markets)
    UNION ALL
    SELECT r.evt_block_number, r.evt_index, r.id,
        CAST(r.assets AS DECIMAL(38,0)), CAST(0 AS DECIMAL(38,0)), CAST(0 AS DECIMAL(38,0))
    FROM morpho_blue_ethereum.morphoblue_evt_repay r
    WHERE r.id IN (SELECT market_id FROM adapter_markets)
),

market_state AS (
    SELECT block_number, log_index, market_id,
        SUM(delta_idle) OVER w          AS idle_usds,
        SUM(delta_total_shares) OVER w  AS total_shares,
        SUM(delta_adapter_shares) OVER w AS adapter_shares
    FROM market_events
    WINDOW w AS (PARTITION BY market_id ORDER BY block_number, log_index ROWS UNBOUNDED PRECEDING)
),

market_adapter_idle AS (
    SELECT block_number, log_index, market_id,
        CASE WHEN total_shares > 0 AND adapter_shares > 0
             THEN CAST(idle_usds AS DOUBLE) * CAST(adapter_shares AS DOUBLE)
                  / CAST(total_shares AS DOUBLE)
             ELSE 0.0 END AS adapter_idle
    FROM market_state
),

-- ─── Vault + adapter USDS cash balance (not yet deployed to markets) ────────
vault_usds_deltas AS (
    SELECT block_number, index AS log_index,
        CASE
            WHEN bytearray_substring(topic1, 13) IN (p.vault, p.adapter)
             AND bytearray_substring(topic2, 13) IN (p.vault, p.adapter)
            THEN CAST(0 AS DECIMAL(38,0))
            WHEN bytearray_substring(topic2, 13) IN (p.vault, p.adapter)
            THEN  CAST(bytearray_to_uint256(data) AS DECIMAL(38,0))
            ELSE -CAST(bytearray_to_uint256(data) AS DECIMAL(38,0))
        END AS delta_usds
    FROM ethereum.logs CROSS JOIN params p
    WHERE contract_address = p.usds_token
      AND topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
      AND (bytearray_substring(topic1, 13) IN (p.vault, p.adapter)
           OR bytearray_substring(topic2, 13) IN (p.vault, p.adapter))
),

vault_usds_running AS (
    SELECT block_number, log_index,
        SUM(delta_usds) OVER (ORDER BY block_number, log_index ROWS UNBOUNDED PRECEDING) AS vault_usds
    FROM vault_usds_deltas
),

-- ─── Dynamic forward-fill: total adapter idle across all discovered markets ─
-- Unified event timeline: every (block, log_index) from any source.
combined_events AS (
    SELECT block_number, log_index FROM market_adapter_idle
    UNION
    SELECT block_number, log_index FROM vault_usds_running
),

-- For each market, expand its idle value to every event in the combined
-- timeline, carrying the last known value forward (LOCF).
market_idle_expanded AS (
    SELECT
        e.block_number,
        e.log_index,
        am.market_id,
        LAST_VALUE(mai.adapter_idle) IGNORE NULLS OVER (
            PARTITION BY am.market_id
            ORDER BY e.block_number, e.log_index
            ROWS UNBOUNDED PRECEDING
        ) AS adapter_idle
    FROM combined_events e
    CROSS JOIN adapter_markets am
    LEFT JOIN market_adapter_idle mai
        ON mai.market_id  = am.market_id
        AND mai.block_number = e.block_number
        AND mai.log_index    = e.log_index
),

-- Sum the forward-filled adapter idle across all markets at each event point.
total_adapter_idle_per_event AS (
    SELECT
        block_number,
        log_index,
        COALESCE(SUM(adapter_idle), 0.0) AS total_adapter_idle
    FROM market_idle_expanded
    GROUP BY block_number, log_index
),

-- Forward-fill vault cash balance across the full combined timeline.
vault_idle_expanded AS (
    SELECT
        e.block_number,
        e.log_index,
        LAST_VALUE(vur.vault_usds) IGNORE NULLS OVER (
            ORDER BY e.block_number, e.log_index
            ROWS UNBOUNDED PRECEDING
        ) AS vault_usds
    FROM combined_events e
    LEFT JOIN vault_usds_running vur
        ON vur.block_number = e.block_number
        AND vur.log_index   = e.log_index
),

-- ─── Total idle USDS time series with block timestamps ──────────────────────
idle_with_ts AS (
    SELECT
        vie.block_number,
        vie.log_index,
        to_unixtime(b.time)                                            AS event_ts,
        (
            COALESCE(tai.total_adapter_idle, 0.0)
            + CAST(COALESCE(vie.vault_usds, CAST(0 AS DECIMAL(38,0))) AS DOUBLE)
        ) / 1e18                                                       AS total_idle_usds
    FROM vault_idle_expanded vie
    JOIN ethereum.blocks b ON b.number = vie.block_number
    CROSS JOIN params_with_apr p
    LEFT JOIN total_adapter_idle_per_event tai
        ON tai.block_number = vie.block_number
        AND tai.log_index   = vie.log_index
    WHERE vie.block_number <= p.to_block
),

-- ─── Integrate total_idle × APR over the period ─────────────────────────────
idle_with_next AS (
    SELECT
        event_ts,
        total_idle_usds,
        LEAD(event_ts) OVER (ORDER BY event_ts, block_number, log_index) AS next_event_ts
    FROM idle_with_ts
),

total_vault_reward AS (
    SELECT SUM(
        total_idle_usds * p.apr
        * (LEAST(COALESCE(next_event_ts, p.to_ts), p.to_ts) - GREATEST(event_ts, p.from_ts))
        / p.seconds_per_year
    ) AS total_reward_usds
    FROM idle_with_next CROSS JOIN params_with_apr p
    WHERE event_ts < p.to_ts
      AND COALESCE(next_event_ts, p.to_ts) > p.from_ts
)

-- ─── Final output ────────────────────────────────────────────────────────────
SELECT
    tvr.total_reward_usds                                             AS reward_usds,
    CAST(tvr.total_reward_usds * 1e18 AS DECIMAL(38, 0))              AS reward_wei
FROM total_vault_reward tvr
