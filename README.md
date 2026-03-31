# IB Vaults Analytics

Analytics workspace for IB Vaults on Ethereum. Tracks the Sky Savings Rate and calculates time-weighted USDS rewards at the vault level for Morpho, AAVE, and Curve vaults.

See [rewards-methodology.md](rewards-methodology.md) for a full description of how rewards are calculated for each vault type.

## Tracked Vaults

**Morpho v2:**
- **Morpho USDS Risk Capital** (Skybase IB): `0xf42bca228d9bd3e2f8ee65fec3d21de1063882d4`
- **Morpho USDS Flagship** (Skybase IB): `0xe15fcc81118895b67b6647bbd393182df44e11e0`

**Morpho v1:**
- **USDS Vault** (Spark): `0xe41a0583334f0dc4e023acd0bfef3667f6fe0597`

**AAVE:**
- **USDS aToken contract**: `0x32a6268f9ba3642dda7892add74f1d34469a4259`

**Curve:**
- **stUSDS/USDS pool contract**: `0x2c7c98a3b1582d83c43987202aeff638312478ae`

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file:
```bash
DUNE_API_KEY=your_dune_api_key
DUNE_USERNAME=your_dune_username
```

## Dune Queries

All reward queries are fully self-contained and derive their inputs entirely from on-chain data. No off-chain data pipeline is required.

### Supporting Queries

**`ib-vaults-ssr.sql`** (Query ID: 6853959)
- Historical SSR (Sky Savings Rate) from SPBEAM contract
- Reads `Set(bytes32 indexed id, uint256 bps)` events where id = "SSR"
- Used by all rewards queries to determine the APR for a given period

### Rewards Queries

**`ib-vaults-rewards-morpho-v2.sql`** (Query ID: 6904585)
- Vault-level time-weighted USDS rewards for Morpho v2 vaults
- Balance = total idle USDS (vault + adapter cash balance + pro-rata unborrowed in Morpho Blue markets)
- Markets are discovered dynamically from on-chain supply events
- Parameters: `{{vault_address}}`, `{{from_timestamp}}`, `{{to_timestamp}}`

**`ib-vaults-rewards-morpho-v1.sql`** (Query ID: 6925830)
- Vault-level time-weighted USDS rewards for Morpho v1 vaults
- Same methodology as v2; the vault itself supplies directly to Morpho Blue (no adapter)
- Parameters: `{{vault_address}}`, `{{from_timestamp}}`, `{{to_timestamp}}`

**`ib-vaults-rewards-aave.sql`** (Query ID: 6860002)
- Vault-level time-weighted USDS rewards for the AAVE USDS vault
- Balance = USDS held by the aToken contract, tracked via USDS Transfer events
- Parameters: `{{from_timestamp}}`, `{{to_timestamp}}`

**`ib-vaults-rewards-curve.sql`** (Query ID: 6864537)
- Vault-level time-weighted USDS rewards for the Curve stUSDS/USDS pool
- Balance = USDS held by the pool contract, tracked via USDS Transfer events
- Parameters: `{{from_timestamp}}`, `{{to_timestamp}}`

**Dependencies:**
```
ib-vaults-rewards-morpho-v2 (6904585) <─ ib-vaults-ssr (6853959)
ib-vaults-rewards-morpho-v1 (6925830) <─ ib-vaults-ssr (6853959)
ib-vaults-rewards-aave      (6860002) <─ ib-vaults-ssr (6853959)
ib-vaults-rewards-curve     (6864537) <─ ib-vaults-ssr (6853959)
```

## Project Structure

```
├── queries/                                   # Dune SQL queries
│   ├── ib-vaults-ssr.sql                      # SSR history from SPBEAM (Query: 6853959)
│   ├── ib-vaults-rewards-morpho-v2.sql        # Morpho v2 rewards (Query: 6904585)
│   ├── ib-vaults-rewards-morpho-v1.sql        # Morpho v1 rewards (Query: 6925830)
│   ├── ib-vaults-rewards-aave.sql             # AAVE rewards (Query: 6860002)
│   └── ib-vaults-rewards-curve.sql            # Curve rewards (Query: 6864537)
├── rewards-methodology.md                     # Reward calculation methodology
└── .env                                       # API keys (not committed)
```

## Adding New Vaults

### Morpho v2 — two changes required

The v2 query uses a `{{vault_address}}` parameter but also needs to resolve each vault to its corresponding adapter contract. This mapping is hardcoded in the `params` CTE as a `CASE` expression (lines 34–39 of `ib-vaults-rewards-morpho-v2.sql`):

```sql
CASE {{vault_address}}
    WHEN 0xe15fcc81118895b67b6647bbd393182df44e11e0   -- Flagship
    THEN 0xf94be39e8863183ff41194b5923627c90a34039d   -- its adapter
    WHEN 0xf42bca228d9bd3e2f8ee65fec3d21de1063882d4   -- Risk Capital
    THEN 0xaaf8bf4b6e8ccb74b7f5e96d4a27ff967c1eef74   -- its adapter
END AS adapter
```

To add a new Morpho v2 vault:
1. Add a new `WHEN <vault_address> THEN <adapter_address>` row to this `CASE` block in the SQL file.
2. Add the new vault address to the `{{vault_address}}` parameter enum on Dune.

### Morpho v1 — Dune parameter only

The v1 query contains no hardcoded vault addresses. The vault itself is the Morpho Blue supplier, so no adapter mapping is needed, and markets are discovered dynamically from on-chain supply events. The SQL requires no changes.

To add a new Morpho v1 vault, only add the new vault address to the `{{vault_address}}` parameter enum on Dune.

### AAVE — SQL edit required

The AAVE query is fixed to a single vault. Both the aToken contract address and the USDS token address are hardcoded literals in the `params` CTE (`ib-vaults-rewards-aave.sql`, lines 29–30):

```sql
0x32a6268f9ba3642dda7892add74f1d34469a4259   AS vault,   -- aToken contract
0xdc035d45d973e3ec169d2276ddab16f1e407384f   AS usds,    -- USDS token
```

To support a different AAVE vault, update these two addresses directly in the SQL. If multiple AAVE vaults need to run simultaneously, the query would need to be restructured to accept a `{{vault_address}}` parameter.

### Curve — SQL edit required

The Curve query is fixed to a single pool. Both the pool contract address and the USDS token address are hardcoded literals in the `params` CTE (`ib-vaults-rewards-curve.sql`, lines 34–35):

```sql
0x2c7c98a3b1582d83c43987202aeff638312478ae   AS vault,   -- pool contract
0xdc035d45d973e3ec169d2276ddab16f1e407384f   AS coins0,  -- USDS token
```

To support a different Curve pool, update these two addresses directly in the SQL. Note that `coins0` must be the address of the USDS token in the target pool.

---

## Usage

**Run a rewards query on Dune:** Visit [dune.com](https://dune.com) and execute the relevant query by ID, or use the Dune MCP via Cursor AI. All queries require `{{from_timestamp}}` and `{{to_timestamp}}`; Morpho queries also require `{{vault_address}}`.

| Vault | Query ID | Parameters |
|-------|----------|------------|
| Morpho v2 (Flagship / Risk Capital) | 6904585 | vault_address, from_timestamp, to_timestamp |
| Morpho v1 (USDS Vault) | 6925830 | vault_address, from_timestamp, to_timestamp |
| AAVE USDS | 6860002 | from_timestamp, to_timestamp |
| Curve stUSDS/USDS | 6864537 | from_timestamp, to_timestamp |
