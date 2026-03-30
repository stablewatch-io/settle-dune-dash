-- IB Vaults Rewards Calculation (Morpho) — V2 test
-- Query ID: 6904585
-- Dune: https://dune.com/queries/6904585
-- Description: Time-weighted USDS reward per depositor for Morpho IB vaults.
--              Total reward = total_idle_usds × APR × time, distributed pro-rata
--              by each depositor's time-weighted share of the vault.
--              Idle calculation is inlined (no separate query dependency).
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
--   query_6852397  ib-vaults-raw   → vault share Transfer events
--   query_6853959  ib-vaults-ssr   → SSR history

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
        0x2f4ea313fb7df23a82c19d95e8b90acc8179bd053e0d9ef745cdf28d6a49499c AS m1_id,
        0x77e624dd9dd980810c2b804249e88f3598d9c7ec91f16aa5fbf6e3fdf6087f82 AS m2_id,
        0xb374528d44b6ab6e0cecc87e0481f45d892f38baec90c1d318851969ec14ea5f AS m3_id,
        0x12cacbbd1c88513cce13d54927f5f1301335779353817bc5e791e71d200f2199 AS m4_id,
        CAST(to_unixtime(CAST('{{from_timestamp}}' AS TIMESTAMP)) AS DOUBLE) AS from_ts,
        CAST(to_unixtime(CAST('{{to_timestamp}}' AS TIMESTAMP)) AS DOUBLE)   AS to_ts,
        (SELECT number FROM ethereum.blocks
         WHERE time >= CAST('{{from_timestamp}}' AS TIMESTAMP) ORDER BY time ASC LIMIT 1) AS from_block,
        (SELECT number FROM ethereum.blocks
         WHERE time <= CAST('{{to_timestamp}}' AS TIMESTAMP) ORDER BY time DESC LIMIT 1)  AS to_block,
        CAST(31557600.0 AS DOUBLE)                                    AS seconds_per_year
),

vault_markets AS (
    SELECT id FROM (
        VALUES
            (0x2f4ea313fb7df23a82c19d95e8b90acc8179bd053e0d9ef745cdf28d6a49499c, 0xe15fcc81118895b67b6647bbd393182df44e11e0),
            (0x77e624dd9dd980810c2b804249e88f3598d9c7ec91f16aa5fbf6e3fdf6087f82, 0xe15fcc81118895b67b6647bbd393182df44e11e0),
            (0xb374528d44b6ab6e0cecc87e0481f45d892f38baec90c1d318851969ec14ea5f, 0xe15fcc81118895b67b6647bbd393182df44e11e0),
            (0x12cacbbd1c88513cce13d54927f5f1301335779353817bc5e791e71d200f2199, 0xe15fcc81118895b67b6647bbd393182df44e11e0),
            (0x77e624dd9dd980810c2b804249e88f3598d9c7ec91f16aa5fbf6e3fdf6087f82, 0xf42bca228d9bd3e2f8ee65fec3d21de1063882d4)
    ) AS t(id, vault_addr)
    CROSS JOIN params WHERE vault_addr = params.vault
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

-- ═══════════════════════════════════════════════════════════════════════════
-- PART A: Total idle USDS time series (inlined from idle query)
-- ═══════════════════════════════════════════════════════════════════════════

-- A1: Per-market idle and adapter share (DECIMAL for precision)
market_events AS (
    SELECT s.evt_block_number AS block_number, s.evt_index AS log_index, s.id AS market_id,
        CAST(s.assets AS DECIMAL(38,0)) AS delta_idle,
        CAST(s.shares AS DECIMAL(38,0)) AS delta_total_shares,
        CASE WHEN s.onBehalf = p.adapter
             THEN CAST(s.shares AS DECIMAL(38,0))
             ELSE CAST(0 AS DECIMAL(38,0)) END AS delta_adapter_shares
    FROM morpho_blue_ethereum.morphoblue_evt_supply s CROSS JOIN params p
    WHERE s.id IN (SELECT id FROM vault_markets)
    UNION ALL
    SELECT w.evt_block_number, w.evt_index, w.id,
        -CAST(w.assets AS DECIMAL(38,0)), -CAST(w.shares AS DECIMAL(38,0)),
        CASE WHEN w.onBehalf = p.adapter
             THEN -CAST(w.shares AS DECIMAL(38,0))
             ELSE CAST(0 AS DECIMAL(38,0)) END
    FROM morpho_blue_ethereum.morphoblue_evt_withdraw w CROSS JOIN params p
    WHERE w.id IN (SELECT id FROM vault_markets)
    UNION ALL
    SELECT b.evt_block_number, b.evt_index, b.id,
        -CAST(b.assets AS DECIMAL(38,0)), CAST(0 AS DECIMAL(38,0)), CAST(0 AS DECIMAL(38,0))
    FROM morpho_blue_ethereum.morphoblue_evt_borrow b
    WHERE b.id IN (SELECT id FROM vault_markets)
    UNION ALL
    SELECT r.evt_block_number, r.evt_index, r.id,
        CAST(r.assets AS DECIMAL(38,0)), CAST(0 AS DECIMAL(38,0)), CAST(0 AS DECIMAL(38,0))
    FROM morpho_blue_ethereum.morphoblue_evt_repay r
    WHERE r.id IN (SELECT id FROM vault_markets)
),

market_state AS (
    SELECT block_number, log_index, market_id,
        SUM(delta_idle) OVER w AS idle_usds,
        SUM(delta_total_shares) OVER w AS total_shares,
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

-- A2: USDS balance in vault + adapter contracts (DECIMAL for precision)
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

-- A3: Merge and forward-fill per market
-- adapter_idle is DOUBLE (ratio result), vault_usds is DECIMAL(38,0) (exact running sum)
idle_merged AS (
    SELECT block_number, log_index, market_id, adapter_idle,
        CAST(NULL AS DECIMAL(38,0)) AS vault_usds
    FROM market_adapter_idle
    UNION ALL
    SELECT block_number, log_index, CAST(NULL AS VARBINARY), CAST(NULL AS DOUBLE), vault_usds
    FROM vault_usds_running
),

idle_filled AS (
    SELECT block_number, log_index,
        COALESCE(LAST_VALUE(CASE WHEN market_id = (SELECT m1_id FROM params) THEN adapter_idle END) IGNORE NULLS OVER w, 0.0) AS idle_m1,
        COALESCE(LAST_VALUE(CASE WHEN market_id = (SELECT m2_id FROM params) THEN adapter_idle END) IGNORE NULLS OVER w, 0.0) AS idle_m2,
        COALESCE(LAST_VALUE(CASE WHEN market_id = (SELECT m3_id FROM params) THEN adapter_idle END) IGNORE NULLS OVER w, 0.0) AS idle_m3,
        COALESCE(LAST_VALUE(CASE WHEN market_id = (SELECT m4_id FROM params) THEN adapter_idle END) IGNORE NULLS OVER w, 0.0) AS idle_m4,
        COALESCE(LAST_VALUE(vault_usds) IGNORE NULLS OVER w, CAST(0 AS DECIMAL(38,0))) AS vault_usds
    FROM idle_merged
    WINDOW w AS (ORDER BY block_number, log_index ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
),

-- A4: Total idle USDS with block timestamps
-- Convert to DOUBLE only at the final division step
idle_with_ts AS (
    SELECT
        f.block_number,
        f.log_index,
        to_unixtime(b.time) AS event_ts,
        (f.idle_m1 + f.idle_m2 + f.idle_m3 + f.idle_m4 + CAST(f.vault_usds AS DOUBLE)) / 1e18 AS total_idle_usds
    FROM idle_filled f
    JOIN ethereum.blocks b ON b.number = f.block_number
    CROSS JOIN params_with_apr p
    WHERE f.block_number <= p.to_block
),

-- A5: Integrate total_idle × APR over the period
idle_with_next AS (
    SELECT event_ts, total_idle_usds,
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
),

-- ─── Final output ───────────────────────────────────────────────────────────
SELECT
    tvr.total_reward_usds                                             AS reward_usds,
    CAST(tvr.total_reward_usds * 1e18 AS DECIMAL(38, 0))              AS reward_wei
FROM total_vault_reward tvr
