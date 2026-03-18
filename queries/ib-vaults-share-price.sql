-- IB Vaults Share Price Timeseries
-- Query ID: 6852700
-- Description: Hourly share price (totalAssets / totalSupply) for Morpho v2 vaults.
--              Data is fetched off-chain via src/fetch-share-prices.ts and
--              uploaded via src/upload-to-dune.ts → dune.cocoahomology.ib_vaults_share_prices.
--
-- Active (Morpho v2):
--   0xf42bca228d9bd3e2f8ee65fec3d21de1063882d4  Morpho USDS Risk Capital (Skybase IB)
--   0xe15fcc81118895b67b6647bbd393182df44e11e0  Morpho USDS Flagship     (Skybase IB)
--
-- TODO - requires separate handling (different protocol / not Morpho v2):
--   0xe41a0583334f0dc4e023acd0bfef3667f6fe0597  USDS Vault  (Spark / Morpho v1)
--   0xdc035d45d973e3ec169d2276ddab16f1e407384f  AAVE USDS   (not Morpho)
--   NOTE: s/b 0x32a6268f9Ba3642Dda7892aDd74f1D34469A4259
--   0x2c7c98a3b1582d83c43987202aeff638312478ae  stUSDS/USDS Pool (not Morpho)
--
-- To refresh data: npm run fetch-share-prices
-- The uploaded table columns:
--   vault_address  varchar   — lowercase hex
--   hour           timestamp — UTC, truncated to hour
--   block_number   bigint    — block used for the eth_call
--   total_assets   varchar   — raw uint256 (wei, 1e18 scale)
--   total_supply   varchar   — raw uint256 (wei, 1e18 scale)
--   share_price    double    — totalAssets / totalSupply (already scaled, ≈ 1.0)

-- ⚠️  CHANGE USERNAME BEFORE USE ⚠️
-- The table below is owned by the Dune account that ran `npm run upload-to-dune`.
-- If you are not cocoahomology:
--   1. Set DUNE_USERNAME in .env to your Dune username
--   2. Run: npm run fetch-share-prices && npm run upload-to-dune
--   3. Replace "cocoahomology" in the FROM clause below with your username
SELECT
    vault_address,
    hour,
    CAST(total_assets AS DOUBLE) / 1e18    AS total_assets,
    CAST(total_supply AS DOUBLE) / 1e18    AS total_supply,
    share_price
FROM dune.cocoahomology.ib_vaults_share_prices
ORDER BY vault_address, hour
