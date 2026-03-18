-- IB Vaults Raw Events
-- Query ID: 6852397
-- Description: All ERC20 Transfer events (full history) for active vaults.
--
-- Active vaults:
--   Morpho USDS Risk Capital (Skybase IB, Morpho v2)
--     0xf42bca228d9bd3e2f8ee65fec3d21de1063882d4
--   Morpho USDS Flagship (Skybase IB, Morpho v2)
--     0xe15fcc81118895b67b6647bbd393182df44e11e0
--   USDS Vault (Spark, Morpho v1)
--     0xe41a0583334f0dc4e023acd0bfef3667f6fe0597
--
-- TODO - not yet tracked:
--   AAVE USDS (not Morpho)
--     0xdc035d45d973e3ec169d2276ddab16f1e407384f
--   stUSDS/USDS Pool (not Morpho)
--     0x2c7c98a3b1582d83c43987202aeff638312478ae

WITH

raw_transfers AS (
    SELECT
        contract_address                                                 AS vault_address,
        block_number,
        block_time,
        tx_hash,
        index                                                            AS log_index,
        bytearray_to_uint256(data)                                       AS shares_raw,
        bytearray_to_uint256(data) / 1e18                                AS shares,
        '0x' || lower(to_hex(bytearray_substring(topic1, 13)))           AS from_address,
        '0x' || lower(to_hex(bytearray_substring(topic2, 13)))           AS to_address
    FROM ethereum.logs
    WHERE contract_address IN (
        0xf42bca228d9bd3e2f8ee65fec3d21de1063882d4,  -- Morpho USDS Risk Capital (Morpho v2)
        0xe15fcc81118895b67b6647bbd393182df44e11e0,  -- Morpho USDS Flagship     (Morpho v2)
        0xe41a0583334f0dc4e023acd0bfef3667f6fe0597   -- USDS Vault               (Spark, Morpho v1)
    )
    AND topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
),

classified AS (
    SELECT
        vault_address,
        block_number,
        block_time,
        tx_hash,
        log_index,
        from_address,
        to_address,
        shares_raw,
        shares,
        CASE
            WHEN from_address = '0x0000000000000000000000000000000000000000' THEN 'deposit'
            WHEN to_address   = '0x0000000000000000000000000000000000000000' THEN 'withdraw'
            ELSE 'transfer'
        END                                                              AS event_type
    FROM raw_transfers
)

SELECT
    vault_address,
    event_type,
    block_number,
    block_time,
    tx_hash,
    log_index,
    from_address,
    to_address,
    shares_raw,
    shares
FROM classified
ORDER BY vault_address, block_number, log_index
