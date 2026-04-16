# Revenue Calculation Nuances: Analyzing Token Allocations for Prime Settlement

## Overview

This report examines the practical challenges encountered when implementing the revenue calculation methodology described in the **Primary Methodology** (https://www.notion.so/Settlement-Methodology-325d79b5de38802f893ce33853d0e499?source=copy_link) and the **Prime Settlement Methodology (Current)** (https://github.com/sky-ecosystem/laniakea-docs/blob/main/accounting/prime-settlement-methodology.md). The analysis is grounded in the implementation of [`src/scripts/fetch-wallet-balances.ts`](src/scripts/fetch-wallet-balances.ts), which computes Sky Revenue and "Star Revenue" (i.e. total actual revenue) for eight token positions in the Spark Prime Agent's holding wallet (`0x1601843c5E9bC251A3272907010AFa41Fa18347E`) over October 2025.

---

## 1. The Time-Segmentation Problem

### What the Methodology Says

The Primary Methodology states:

> "The month is divided into segments. For each segment: (1) Apply compound return = (1 + segment Return)^(1/segment) − 1; (2) Calculate Base Rate Charge = Asset Value × (Base Rate / 365) × Segment Duration."

It also notes: "Hourly snapshots collected at staggered times per chain (e.g. :14 ETH, :17 Base, :19 others)."

### What We Actually Observe

For most positions in the allocation system, **the month cannot be cleanly divided into hourly (or even daily) segments** because the positions experience frequent inflows and outflows within those segments. The transfer counts during October 2025 demonstrate this:

| Token | Transfers in Oct 2025 | Event-Timeseries Entries |
|---|---|---|
| Syrup USDC | 58 | 60 |
| Spark PYUSD | 102 | 104 |
| Spark DAI | 124 | 125 |
| Spark USDT | 420 | 422 |
| Spark USDS | 127 | 128 |
| Spark.fi USDT Reserve | 0 (LP — transfers skipped) | 2 |
| Spark.fi PYUSD Reserve | 0 (LP — transfers skipped) | 2 |
| Savings USDS (Base) | 0 | 2 |

Spark USDT, for example, saw **420 transfer events** in October alone — roughly 14 per day. Each such transfer changes the principal on which both Sky Revenue and Star Revenue are calculated. Hourly snapshots would miss most of these events, so an event-driven approach is needed.

**Key observation**: Both the Sky Revenue and actual total revenue calculations depend on capturing all capital flows, because every allocation or deallocation changes the principal base. A fixed-segment approach would require interpolation or would systematically misattribute principal changes as revenue. The methodology's reference to "hourly snapshots" is therefore insufficient for tokens with intra-hour flows.

*Note: The script in `fetch-wallet-balances.ts` uses a rough event-driven approach (snapshotting balances around each transfer) to approximate these figures for exploratory analysis. It is not a rigorous implementation of either methodology — the figures cited in this report are estimates used to illustrate the structural challenges, not authoritative settlement numbers.*

---

## 2. Case Analysis: Distinct Revenue Patterns

### 2.1 Syrup USDC — Price-Appreciating Vault Token

**Results (October 2025):**

| Metric | Value |
|---|---|
| Star Revenue | $3,308,681.53 |
| Sky Revenue | $2,683,286.45 |
| Prime Revenue (derived) | $625,395.08 |
| Net USD Value Change | −$136,759.77 |
| Net Transfer Value | $3,445,441.29 |

Syrup USDC is an ERC-4626 vault token. Its price continuously appreciates as the underlying USDC lending pool accrues interest (price rose from ~1.1279 to ~1.1332 over October). The wallet saw 58 outbound redemption transfers during the month.

**Revenue mechanics**: The net USD value *decreased* because outflows (redemptions) exceeded price appreciation. The Star Revenue is positive only because `netUsdValueTransfers` accounts for the principal removed. The price appreciation on the remaining balance is the actual earned yield.

**Critical nuance for the methodology**: When the Prime redeems Syrup USDC, the appreciation since deposit is *realized*. This realized gain is actual revenue that the Prime earns, and it must not be counted as debt owed to Sky. The script correctly handles this by pricing transfers at `convertToAssets` at the transfer block, isolating the principal flow from accumulated yield. However, the methodology does not explicitly describe how to handle this distinction for vault tokens where "Asset Value" is denominated in shares, not underlying.

**Question for the methodology**: What exactly is "Asset Value" for a vault token? Is it `shares × convertToAssets(1)` (the underlying value), or the share count itself? The compound return formula `(1 + segmentReturn)^(1/segment) − 1` implies the price change is the return, but this conflates price appreciation (which is revenue) with share count changes (which are principal flows).

### 2.2 SparkLend Allocations (PYUSD, USDT, DAI, USDS) — Frequent Flows and Principal vs. Interest

**Spark PYUSD Results:**

| Metric | Value |
|---|---|
| Star Revenue | $935,236.56 |
| Sky Revenue | $2,112,620.81 |
| Prime Revenue (derived) | −$1,177,384.25 |
| Net USD Value Change | $27,146,146.73 |
| Net Transfer Value | −$26,210,910.17 |

**Spark USDT Results:**

| Metric | Value |
|---|---|
| Star Revenue | $2,150,142.49 |
| Sky Revenue | $3,431,967.22 |
| Prime Revenue (derived) | −$1,281,824.73 |
| Net USD Value Change | $191,951,096.03 |
| Net Transfer Value | −$189,800,953.54 |

These positions demonstrate the most complex case. SparkLend aToken balances grow via two distinct mechanisms:
1. **Interest accrual**: `balanceOf` returns scaled balances that automatically increase as the liquidity index grows
2. **Principal changes**: Deposits and withdrawals via the Allocation System change the underlying principal

With 102 transfers (PYUSD) and 420 transfers (USDT) in a single month, the principal base is constantly shifting. The script isolates transfers from interest by comparing `balanceOf(block+1)` vs `balanceOf(block-1)` around each transfer, with the ~24-second gap ensuring minimal interest contamination.

**Gap in the methodology**: The Primary Methodology provides no guidance on how to distinguish interest from principal in a lending position with frequent flows. The formula `Asset Value × (Base Rate / 365) × Segment Duration` requires knowing the "Asset Value" (i.e., the principal), but for a SparkLend position that receives 14 deposits/withdrawals per day (Spark USDT), the principal changes intra-segment. The methodology needs to specify:

1. **How to handle intra-segment principal changes**: Are they pro-rated within the segment? Does a deposit at hour 8 of a 24-hour segment contribute 16/24 of the daily base rate?
2. **How to separate accrued interest from principal in the "Asset Value"**: SparkLend aTokens include accumulated interest in `balanceOf`. Should the methodology use the *original deposited principal* or the *current balance including accrued interest* as the base for Sky Revenue?
3. **How to handle the "balanceIncrease" in SparkLend**: Transfer events emit values that are `underlying − balanceIncrease` (a tiny interest accrual delta), not the full transfer amount. The script works around this by using balance deltas instead of raw transfer values, but this workaround is not documented in the methodology.

### 2.3 Idle Lending: Spark DAI and Spark USDS

**Spark DAI Results:**

| Metric | Value |
|---|---|
| Star Revenue | $1,263,946.30 |
| Sky Revenue | $1,332,206.99 |
| Prime Revenue (derived) | −$68,260.68 |

**Spark USDS Results:**

| Metric | Value |
|---|---|
| Star Revenue | $636,415.56 |
| Sky Revenue | $685,561.01 |
| Prime Revenue (derived) | −$49,145.44 |

These are SparkLend positions where a portion of the deposited DAI/USDS sits **idle** (unborrowed) in the lending pool. Only borrowed capital generates supply-side interest for the depositor.

**Script methodology for idle lending**: The script introduces an `idleLending` sky revenue module that scales each day's Sky Revenue contribution by the pool utilization rate:

```
idleFactor = 1 − (underlyingBalance held by pool / totalSupply of spToken)
dailySkyRevenue = usdValue × (baseRate / 365.25) × idleFactor
```

This means that if 30% of the deposited DAI is sitting idle in SparkLend, only 70% of the position's value accrues the Base Rate charge. The rationale is that idle capital is not "allocated" in the economic sense — it is not generating yield, so charging the Base Rate on it would systematically disadvantage the Prime.

**Gap in the Primary Methodology**: The Primary Methodology does not specify how to handle idle capital within lending positions. It mentions that `idle USDS` or `USDS minted but not 'backed'` (such as USDS in PSM or AllocationBuffer contracts) are handled differently, but says nothing about idle fractions within a SparkLend deposit. This is a significant omission — for Spark DAI and Spark USDS, the idle fraction can be substantial and volatile, and ignoring it would materially overstate Sky Revenue.

---

## 3. Conflict Between the Two Methodologies

### Primary Methodology: Sky Revenue Is Computed Per-Asset

In the Primary Methodology, Sky Revenue is calculated as:

```
Sky Revenue = Σ [ Asset Value × (Base Rate / 365) × Segment Days ]
```

This is a **bottom-up** calculation: sum the Base Rate charge across each allocated asset position. The total Sky Revenue is the aggregate across all positions.

### Prime Settlement Methodology: Debt Fees Use Ilk Debt

In the Prime Settlement Methodology (the five-step draft), the starting point is fundamentally different:

```
Maximum Debt Fees = Average Ilk Debt × Monthly Rate
```

Where `Average Ilk Debt` is the time-weighted average of the Prime's outstanding borrowed amount, read from the Vat contract (`ALLOCATOR-SPARK-A`).

### The Contradiction

These two approaches **can yield different results** because:

1. **Ilk Debt vs. Sum of Asset Values**: The ilk debt (from the Vat contract) is the total USDS minted by the Prime. The sum of all asset values may differ because:
   - Some minted USDS is idle (in PSM, AllocationBuffer, etc.)
   - Asset values fluctuate with price changes, interest accrual, etc.
   - The ilk debt includes accumulated stability fees

2. **Handling of Idle Capital**: In the Primary Methodology, idle USDS/DAI appears to be *excluded* from Sky Revenue (since it's not an "allocated" asset category — there is no guidance on how to handle it beyond a truncated sentence in the definition section). In the Prime Settlement Methodology, idle capital is handled explicitly: the Prime pays the full Base Rate on all debt (Step 1), then receives reimbursements for idle USDS/DAI (Step 2). The *net effect* should be similar — the Prime only pays the Base Rate on actively deployed capital — but the calculation path is different and could diverge due to timing, valuation, or rounding.

3. **sUSDS Treatment**: The Primary Methodology charges `SSR` (not Base Rate) on USDS Savings positions and describes proportional adjustments for underperformance. The Prime Settlement Methodology treats sUSDS profits as purely the *spread above Base Rate* (Step 3: `sUSDS Profit = Average Idle sUSDS Balance × Spread Rate`). This implies the Base Rate portion of sUSDS yield is netted against the Step 1 debt fee, and only the 0.3% spread is profit. These are mathematically equivalent in steady state, but may diverge when balances change intra-period.

4. **Sky Direct Exposure**: On this point the two methodologies are **consistent in outcome**, though framed differently. The Primary Methodology states that Sky always receives the Base Rate Charge and absorbs any shortfall: `Sky Revenue = Base Rate Charge (always); Prime Revenue = max(0, Actual Revenue − Base Rate Charge)`. The Prime Settlement Methodology arrives at the same result via reimbursement: the Prime pays the full debt fee (Step 1), then receives `Reimbursement = MAX(0, Base Rate Profit − Actual Profit)` (Step 4), netting the Prime's loss to zero. The net settlement amounts are mathematically equivalent; only the accounting path differs (gross charge + shortfall absorption vs. gross fee + reimbursement).

**Bottom line**: The Primary Methodology computes Sky Revenue bottom-up from asset positions; the Prime Settlement Methodology computes Maximum Debt Fees top-down from ilk debt and then applies reimbursements. If the sum of position-level Sky Revenue charges does not equal the ilk-debt-based Maximum Debt Fee minus reimbursements, the two methodologies produce different settlement amounts. The methodology documents do not address this potential divergence or specify which takes precedence.

---

## 4. Open Questions from Historical Spark October 2025 MSC Analysis

The following questions arise from comparing the script's outputs against historical MSC (Monthly Settlement Cycle) data for October 2025.

### 4.1 Off-Chain Transfers for Syrup USDC and PYUSD

The historical Spark October 2025 MSC analysis indicates that Syrup USDC and PYUSD revenues include possibly off-chain transfers. When examining all on-chain flows into the subproxy wallet (`0x1601843c5E9bC251A3272907010AFa41Fa18347E`), no possible such onchain revenue transfers are visible. **Where can these off-chain revenues be found?**

### 4.2 LP Token Sky Revenue Principals (Spark.fi PYUSD Reserve and Spark.fi USDT Reserve)

In the historical Spark October 2025 MSC, the Sky Revenues for these Curve LP tokens appear to be based on principal amounts that are difficult to reconcile:

- **Spark.fi USDT Reserve**: Sky Revenue appears to be based on the entire USD value of all tokens held in the LP pool, not just the wallet's proportional share of a single underlying token.
- **Spark.fi PYUSD Reserve**: Sky Revenue appears to be based on a principal that is too small to be either the total pool value or even a single token's proportion.

This inconsistency suggests that the methodology for LP token principal calculation is unclear or inconsistently applied. **Having explicit guidelines on idle asset handling in the methodology would help clarify these cases**, as part of the LP position may effectively be "idle" (e.g., the non-target-token side of the pool, or the fraction of the target token not currently being utilized by borrowers).

Furthermore, the **Prime Revenue for Spark.fi PYUSD Reserve is $0** in the historical analysis, while Spark.fi USDT Reserve appears to have positive Prime Revenue. If these are both Curve LP positions earning Curve APY rewards, why would one have zero Prime Revenue? Are Curve trading fees and/or CRV rewards excluded from the Prime Revenue calculation for PYUSD but not USDT?

### 4.3 Superstate Crypto Carry Fund and USDe — Revenue Sum Mismatch

For the tokens **Superstate Crypto Carry Fund** and **USDe**, the Sky Revenue and Prime Revenue do not sum to the total revenue for the October 2025 MSC cycle:

```
Sky Revenue + Prime Revenue ≠ Total Revenue
```

**What is this special case?**

### 4.4 sUSDS Revenue Handling in October 2025 MSC

In the historical Spark October 2025 MSC:
- The **Sky Revenue** for sUSDS appears to be calculated based on the SSR.
- The **Prime Revenue** for sUSDS is **0**.

**In my view**, the expected treatment should be:
- Sky Revenue = position value × Base Rate (what Sky is owed for providing the capital)
- Prime Revenue = position value × SSR

### 4.5 Principal Calculation for Compounding and Volatile Positions

**The fundamental question**: How should the principal amount for each allocation be determined for the "Asset Value" in the Sky Revenue formula?

Consider two examples:

**sUSDS (price-appreciating compounding asset)**: If a Prime deposits $100M of sUSDS at the start of the month, and the sUSDS price appreciates by 0.4% over the month, the position is worth $100.4M at month end. For the MSC Sky Revenue calculation:
- Is the "Asset Value" the $100M initial principal? (This appears to be the case in the historical Spark October 2025 MSC.)
- Or is it the time-weighted average value including appreciation ($100.2M)?
- The formula says `Asset Value × (Base Rate / 365) × Segment Days`, but "Asset Value" is undefined for compounding tokens.

**SparkLend (constantly-changing principal with accruing interest)**: For Spark USDT with 420 transfers in October:
- The position started at $547M, ended at $739M, with constant deposits and withdrawals.
- Interest continuously accrues via the liquidity index.
- What is the "principal" at any given moment? Is it the deposited principal (excluding accrued interest)? The `balanceOf` value (including accrued interest)? The time-weighted average of either?

The Primary Methodology does not specify how to compute "Asset Value" for these cases. The compound return formula `(1 + segmentReturn)^(1/segment) − 1` implies the asset value includes price changes within the segment, but this creates a circular dependency: the Sky Revenue charge depends on the asset value, which depends on the interest accrued, which is part of the revenue being split.

**This appears to be a genuine gap in both methodologies**, not merely an implementation detail. For positions with frequent flows and continuous interest accrual, the calculation order and principal definition materially affect the settlement amount. Explicit guidance is needed on:

1. Whether "Asset Value" means deposited principal or current market value
2. How to handle principal changes from transfers within a segment
3. Whether accrued-but-unrealized interest is included in the "Asset Value" for computing the Base Rate Charge

---

## 5. Recommendations

1. **Define "Asset Value" precisely**: For each asset category, specify whether this means deposited principal, current balance including accrued interest, or time-weighted average balance.

2. **Specify SparkLend/Aave/Morpho principal/interest separation**: This is the most implementation-critical gap. SparkLend aToken `balanceOf` returns a value that *includes* continuously accrued interest (via the liquidity index), and Transfer events emit amounts *net of* a `balanceIncrease` accrual delta — neither source cleanly isolates principal from interest. With hundreds of allocation/deallocation transfers per month, the methodology must specify: (a) how to decompose each transfer into principal movement vs. interest realization; (b) whether "Asset Value" for the Base Rate Charge is the deposited principal or the current balance including accrued interest; and (c) how to handle the compounding effect when interest-inclusive balances are used as the principal base for subsequent segments. Without this, implementers face a circular dependency: the Sky Revenue charge depends on the asset value, which depends on accrued interest, which is part of the revenue being split.

3. **Adopt event-driven segmentation**: Rather than fixed hourly/daily segments, define segments as the intervals between capital flow events. This is the only approach that correctly handles months with hundreds of transfers per token.

4. **Specify idle-lending treatment**: For SparkLend positions, document whether the Base Rate Charge applies to the full deposit or only the utilized (borrowed) fraction.

5. **Reconcile per-position PnL with the authoritative settlement**: The Prime Settlement Methodology (ilk-debt-based Maximum Debt Fees minus reimbursements) is the authoritative settlement calculation. However, if we want to retain per-position PnL breakdowns as described in the Primary Methodology, we need guidance on how to allocate the debt portion across individual positions such that the per-position Sky Revenues sum to the correct aggregate. The bottom-up sum of per-asset `Asset Value × Base Rate` charges will not, in general, equal the top-down `Average Ilk Debt × Rate` — the ilk debt includes idle capital, stability fee accrual, and other components absent from individual position values. How should the debt be apportioned to each position? Should idle capital be treated as its own "position" with a Sky Revenue equal to its reimbursement?

6. **Document LP token handling**: Specify how Curve LP positions should be valued (proportional share of one underlying token? both? total pool value?) and how Curve trading fees/rewards are attributed.

7. **Clarify off-chain revenue channels**: Document where off-chain revenues for Syrup USDC and PYUSD are recorded and how they are incorporated into the settlement calculation.
