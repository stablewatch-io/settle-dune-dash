# IB Vaults Rewards Methodology

This document describes how rewards are calculated for each type of IB vault. All vault types use the same core approach — time-weighted USDS balance tracking at the vault level — but differ in how the vault's USDS balance is derived.

## Covered vaults

| Protocol | Vault | Address |
|----------|-------|---------|
| Morpho v2 | Morpho USDS Risk Capital | `0xf42bca228d9bd3e2f8ee65fec3d21de1063882d4` |
| Morpho v2 | Morpho USDS Flagship | `0xe15fcc81118895b67b6647bbd393182df44e11e0` |
| Morpho v1 (Spark) | USDS Vault | `0xe41a0583334f0dc4e023acd0bfef3667f6fe0597` |
| AAVE | USDS aToken contract | `0x32a6268f9ba3642dda7892add74f1d34469a4259` |
| Curve | stUSDS/USDS pool contract | `0x2c7c98a3b1582d83c43987202aeff638312478ae` |

## Common methodology

Rewards are calculated over a fixed time period (e.g. one week) at the vault level:

1. **Reconstruct the balance timeline.** Using on-chain events, rebuild the vault's USDS balance at every point during the period. The exact source of events differs by vault type (see below).

2. **Split into segments.** Each time an event changes the vault's USDS balance, a new segment begins. A segment is a contiguous stretch of time where the balance is constant.

3. **Calculate per-segment reward.** For each segment:

   ```
   segment_reward = usds_balance * apr * segment_duration / seconds_per_year
   ```

   where `seconds_per_year = 31,557,600` (365.25 days).

4. **Sum all segments.** The total reward is the sum of all segment rewards over the period.

The **APR** used is the Sky Savings Rate (SSR) in effect at the start of the period, held constant for the entire period. If the SSR changes mid-period, the calculation does not split the rate across segments — this is a known simplification.

The key difference between vault types is how **usds_balance** is derived.

---

## 1. Morpho vaults

**Vaults covered:**
- Morpho USDS Risk Capital (v2): `0xf42bca228d9bd3e2f8ee65fec3d21de1063882d4`
- Morpho USDS Flagship (v2): `0xe15fcc81118895b67b6647bbd393182df44e11e0`
- USDS Vault (Spark, v1): `0xe41a0583334f0dc4e023acd0bfef3667f6fe0597`

**Balance definition:** The reward-eligible balance is the vault's **total idle USDS** at any given moment, defined as:

```
total_idle_usds = vault_cash_balance + sum over all markets of (vault's pro-rata share of unborrowed USDS)
```

- **Vault cash balance** is the USDS sitting in the vault (and adapter, for v2) that has not yet been deployed to any market. Tracked via USDS ERC20 Transfer events to and from the vault/adapter contract addresses.
- **Unborrowed USDS per market** is the USDS supplied to a Morpho Blue market that has not been borrowed out. Tracked via Morpho Blue supply, withdraw, borrow, and repay events. Only the vault's pro-rata share (based on its share of market deposits) counts.
- **Markets** are discovered dynamically from historical supply events — no market IDs are hardcoded.

**V1 vs V2 architecture:**
- *V2 vaults* route capital through an intermediate adapter contract before it reaches Morpho Blue markets. The adapter is the `onBehalf` address in Morpho Blue supply events.
- *V1 vaults* supply to Morpho Blue markets directly; the vault itself is the `onBehalf` address.

The reward formula is otherwise identical for both versions.

**Idle factor:** Not applied. The idle balance is computed exactly from on-chain state rather than approximated with a flat multiplier.

**Per-segment reward formula:**

```
segment_reward = total_idle_usds * apr * segment_seconds / seconds_per_year
```

---

## 2. AAVE

**Vault:** AAVE USDS aToken contract (`0x32a6268f9ba3642dda7892add74f1d34469a4259`).

**Balance definition:** The reward-eligible balance is the **USDS held by the aToken contract**, tracked via USDS ERC20 Transfer events into and out of the aToken contract address. This reflects the underlying principal deposited, rather than the aToken's rebasing balance which grows over time as Aave accrues interest internally.

**Idle factor:** Not applied.

**Per-segment reward formula:**

```
segment_reward = usds_balance * apr * segment_seconds / seconds_per_year
```

---

## 3. Curve stUSDS/USDS

**Vault:** Curve stUSDS/USDS pool contract (`0x2c7c98a3b1582d83c43987202aeff638312478ae`).

**Balance definition:** The reward-eligible balance is the **USDS held by the pool contract**, tracked via USDS ERC20 Transfer events into and out of the pool contract address. No LP token balances or LP-to-USDS ratio calculations are used.

**Idle factor:** Not applied.

**Per-segment reward formula:**

```
segment_reward = usds_balance * apr * segment_seconds / seconds_per_year
```

---

## Comparison table

| | Morpho v2 | Morpho v1 | AAVE | Curve |
|---|---|---|---|---|
| Balance tracked | Total idle USDS (cash + pro-rata unborrowed in markets) | Total idle USDS (cash + pro-rata unborrowed in markets) | USDS held by aToken contract | USDS held by pool contract |
| Balance source | Morpho Blue market events + USDS transfers | Morpho Blue market events + USDS transfers | USDS ERC20 Transfer events | USDS ERC20 Transfer events |
| Market discovery | Dynamic (from supply events via adapter) | Dynamic (from supply events via vault) | N/A | N/A |
| Off-chain data required | No | No | No | No |
| Idle factor | No | No | No | No |
