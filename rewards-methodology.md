# IB Vaults Rewards Methodology

This document describes how rewards are calculated for each type of IB vault. All three vault types use the same core approach — time-weighted balance tracking — but differ in how a depositor's balance is converted to a USDS-denominated amount.

## Covered tokens

| Protocol | Token | Address |
|----------|-------|---------|
| Morpho v2 | Morpho USDS Risk Capital | `0xf42bca228d9bd3e2f8ee65fec3d21de1063882d4` |
| Morpho v2 | Morpho USDS Flagship | `0xe15fcc81118895b67b6647bbd393182df44e11e0` |
| Morpho v1 (Spark) | USDS Vault | `0xe41a0583334f0dc4e023acd0bfef3667f6fe0597` |
| AAVE | USDS aToken | `0x32a6268f9ba3642dda7892add74f1d34469a4259` |
| Curve | stUSDS/USDS LP token | `0x2c7c98a3b1582d83c43987202aeff638312478ae` |

## Common methodology

Rewards are calculated over a fixed time period (e.g. one week). For each depositor:

1. **Reconstruct the balance timeline.** Using on-chain ERC-20 Transfer events, rebuild each depositor's token balance at every point during the period.

2. **Split into segments.** Each time a deposit, withdrawal, or transfer changes a depositor's balance, a new segment begins. A segment is a contiguous stretch of time where the balance is constant.

3. **Calculate per-segment reward.** For each segment:

   ```
   segment_reward = usds_balance * apr * segment_duration / seconds_per_year
   ```

   where `seconds_per_year = 31,557,600` (365.25 days).

4. **Sum all segments.** A depositor's total reward is the sum of all their segment rewards over the period.

The **APR** used is the Sky Savings Rate (SSR) in effect at the start of the period, held constant for the entire period. If the SSR changes mid-period, the calculation does not split the rate across segments — this is a known simplification.

The key difference between vault types is how **usds_balance** is derived from the raw token balance.

---

## 1. Morpho vaults

**Tracked tokens:** Morpho vault shares (ERC-20 balance of the vault token).
- Morpho USDS Risk Capital: `0xf42bca228d9bd3e2f8ee65fec3d21de1063882d4`
- Morpho USDS Flagship: `0xe15fcc81118895b67b6647bbd393182df44e11e0`
- USDS Vault (Spark, Morpho v1): `0xe41a0583334f0dc4e023acd0bfef3667f6fe0597`

**Balance-to-USDS conversion:** Morpho vault shares are not 1:1 with USDS. The conversion uses a *share price*, defined as:

```
share_price = vault.totalAssets() / vault.totalSupply()
```

This ratio is read directly from the vault smart contract via archive node RPC calls at hourly intervals. The data is collected by an off-chain script (`fetch-share-prices.ts`), saved to a CSV, and uploaded to Dune as a custom table. The rewards query then looks up the share price at the hour of period start and the hour of period end, and averages them:

```
avg_share_price = (share_price_at_start + share_price_at_end) / 2
```

**Idle factor:** An `idle_factor` (e.g. 0.80) is applied to discount the APR, reflecting the fraction of vault capital that is actively deployed vs. sitting idle. This is currently a single constant for the entire period. If more precision is needed, the exact idle balance could be reconstructed within the query from on-chain vault state and applied per-segment instead of as a flat multiplier.

**Per-segment reward formula:**

```
segment_reward = (shares / 1e18) * avg_share_price * idle_factor * apr * segment_seconds / seconds_per_year
```

---

## 2. AAVE

**Tracked token:** AAVE USDS aToken (`0x32a6268f9ba3642dda7892add74f1d34469a4259`).

**Balance-to-USDS conversion:** 1 aToken = 1 USDS. No conversion is necessary — the raw aToken balance is used directly as the USDS balance.

**Idle factor:** Not applied.

**Per-segment reward formula:**

```
segment_reward = (atoken_balance / 1e18) * apr * segment_seconds / seconds_per_year
```

---

## 3. Curve stUSDS/USDS

**Tracked token:** Curve stUSDS/USDS LP token (`0x2c7c98a3b1582d83c43987202aeff638312478ae`).

**Balance-to-USDS conversion:** Holding LP tokens entitles the depositor to a proportional share of the underlying pool assets. Rewards are based on the depositor's claim on **coins(0)** (USDS, `0xdc035d45d973e3ec169d2276ddab16f1e407384f`), not on coins(1) (stUSDS). The conversion uses:

```
usds_per_lp = pool_usds_balance / lp_total_supply
```

where `pool_usds_balance` is the amount of USDS held by the pool contract, and `lp_total_supply` is the total LP tokens in circulation.

Both values are reconstructed entirely from on-chain data as running sums:
- **Pool USDS balance** is computed as the running sum of all USDS Transfer events into and out of the pool contract address.
- **LP total supply** is computed as the running sum of LP token mints (transfers from `0x000...`) minus burns (transfers to `0x000...`).

These running sums form a time series of the ratio at every on-chain event that changes either value. Each reward segment uses the exact `usds_per_lp` ratio in effect at its start block, not a period-wide average.

This reconstruction approximates `pool.balances(0)` from the Curve contract. The Curve contract's internal `balances(0)` excludes accumulated admin fees, while the transfer-based reconstruction includes them. The difference is negligible — admin fees are roughly 0.02% of cumulative swap volume — and the error in the *ratio* is even smaller since fees are collected proportionally from both tokens.

**Idle factor:** Not applied.

**Per-segment reward formula:**

```
segment_reward = (lp_balance / 1e18) * coins0_per_lp * apr * segment_seconds / seconds_per_year
```

---

## Comparison table

| | Morpho | AAVE | Curve |
|---|---|---|---|
| Tracked token | Vault shares | aToken | LP token |
| Balance = USDS? | No | Yes (1:1) | No |
| Conversion method | `totalAssets / totalSupply` (off-chain RPC) | None needed | `pool_usds / lp_supply` (on-chain events) |
| Conversion data source | Off-chain script + Dune custom table | N/A | Ethereum Transfer event logs |
| Idle factor | Yes (configurable) | No | No |
