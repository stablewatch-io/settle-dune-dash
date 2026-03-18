-- IB Vaults SSR History
-- Query ID: 6853959
-- Description: Historical SSR (Sky Savings Rate) values from the SPBEAM contract.
--              Each row represents a block where a new SSR took effect.
--
-- Contract:  0x36b072ed8afe665e3aa6daba79decbec63752b22  SPBEAM (SP-BEAM)
-- Event:     Set(bytes32 indexed id, uint256 bps)
--   topic0 = 0x28e3246f80515f5c1ed987b133ef2f193439b25acba6a5e69f219e896fc9d179
--   topic1 = 0x5353520000000000000000000000000000000000000000000000000000000000  ("SSR")
--   data   = bps as uint256
--
-- Multiple Set events per block: the cooldown (tau) on the contract prevents more than
-- one set() call per block.timestamp interval. Since all txs in a block share the same
-- timestamp, at most one Set(SSR) fires per block in practice. MAX_BY(log_index) is
-- used defensively in case tau = 0 allows multiple calls.

WITH ssr_events AS (
    SELECT
        block_number,
        block_time,
        index                          AS log_index,
        bytearray_to_uint256(data)     AS bps
    FROM ethereum.logs
    WHERE contract_address = 0x36b072ed8afe665e3aa6daba79decbec63752b22
      AND topic0 = 0x28e3246f80515f5c1ed987b133ef2f193439b25acba6a5e69f219e896fc9d179
      AND topic1 = 0x5353520000000000000000000000000000000000000000000000000000000000
)

SELECT
    block_number,
    block_time,
    MAX_BY(bps, log_index)             AS bps,
    MAX_BY(bps, log_index) / 10000.0   AS apr
FROM ssr_events
GROUP BY block_number, block_time
ORDER BY block_number
