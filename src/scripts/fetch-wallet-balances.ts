/**
 * Fetches daily ERC-20 token balances for a holding wallet across Oct 2025
 * and stores results in data/wallet-balances.json.
 *
 * - Already-fetched entries are detected and skipped on re-runs.
 * - Token decimals are fetched once and cached alongside the timeseries.
 * - SSR values are hardcoded and written on every run.
 * - Add new assets to ASSETS to extend coverage; existing data is preserved.
 *
 * Usage:
 *   npm run fetch-wallet-balances
 *
 * Requires .env:
 *   ETHEREUM_RPC_URL    — Alchemy (or any archive node) RPC endpoint
 *   ETHERSCAN_API_KEY   — Etherscan v2 API key
 */

import { ethers } from 'ethers';
import { config } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import EthDater from 'ethereum-block-by-date';
import { getDefiLlamaPriceByTimestamp } from '../lib/price-utils.js';

config();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WALLET = '0x1601843c5E9bC251A3272907010AFa41Fa18347E';

/** SSR changes at (and after) this block number. */
const SSR = {
  changeBlock: 23670008,
  before: 0.0475,
  atOrAfter: 0.045,
} as const;

/**
 * Added to the raw SSR rate when computing skyRevenueEstimate.
 * baseRate = ssrRate + BASE_RATE_PREMIUM
 */
const BASE_RATE_PREMIUM = 0.003;

/**
 * Describes how to price a token at a given block.
 *   convertToAssets      — calls ERC-4626 convertToAssets(1e18) on-chain; price = result / 1e18
 *   fixed                — constant price, no on-chain call needed
 *   aaveNormalizedIncome — calls Pool.getReserveNormalizedIncome(underlying) on-chain.
 *                          SparkLend / Aave V3 aTokens store balances and emit Transfer values
 *                          in their internal scaled representation; this index converts them to
 *                          the actual underlying token amount.
 *                          price = getReserveNormalizedIncome(underlying) / 1e27
 *   defiLlama            — fetches historical price from DeFiLlama by timestamp.
 *                          Uses getDefiLlamaPriceByTimestamp(tokenAddress, blockchain, timestamp).
 */
type PricingModule =
  | { type: 'convertToAssets' }
  | { type: 'fixed'; price: number }
  | { type: 'aaveNormalizedIncome'; poolAddress: string; underlyingAsset: string }
  | { type: 'defiLlama'; blockchain: string; tokenAddress: string };

/**
 * Optional modifier for skyRevenueEstimate.
 *   idleLending — multiplies each daily yield by (1 − underlyingBalance/totalSupply),
 *                 i.e. only the deployed (non-idle) fraction earns the SSR base rate.
 *                 underlyingBalance = balance of underlyingAddress held by the token contract.
 *                 totalSupply       = total supply of the token contract itself.
 */
type SkyRevenueModule =
  | { type: 'idleLending'; underlyingAddress: string }
  /**
   * ssrRate — charges the SSR alone (without the BASE_RATE_PREMIUM) as Sky Revenue.
   * Used for USDS Savings assets (e.g. sUSDS) where the methodology specifies that
   * Sky Revenue = SSR Charge, not the full Base Rate.
   */
  | { type: 'ssrRate' };

/**
 * Describes how to compute the effective token balance for a wallet position.
 *   balanceOf — standard ERC-20 balanceOf(wallet) (default)
 *   curveLP   — wallet's proportional share of a specific underlying token held
 *               by a Curve Stableswap-NG pool:
 *               share = (walletLPBalance / lpTotalSupply) × poolTargetTokenBalance
 *               Effective decimals = target token's decimals (not the LP token's).
 */
type BalanceModule =
  | { type: 'balanceOf' }
  | { type: 'curveLP'; targetToken: string };

interface AssetConfig {
  address: string;
  name: string;
  /**
   * How to price the balance returned by the balance resolver (balanceOf / curveLP).
   * Used for timeseries and eventTimeseries usdValue calculations.
   */
  pricingModule?: PricingModule;
  /**
   * How to price the raw value from Etherscan ERC-20 Transfer events.
   * Defaults to `pricingModule` when not set.
   * NOTE: SparkLend aToken Transfer events emit underlying minus balanceIncrease
   * (a tiny interest accrual delta), NOT the fully scaled amount. Both balanceOf
   * and Transfer values are effectively in underlying units, so `fixed: 1` is
   * correct for both — do NOT use `aaveNormalizedIncome` for transfers.
   */
  transferPricingModule?: PricingModule;
  balanceModule?: BalanceModule;
  /**
   * Optional modifier for skyRevenueEstimate.
   * 'idleLending' scales each day's yield by the pool utilisation rate.
   */
  skyRevenueModule?: SkyRevenueModule;
  /** Skip Etherscan transfer fetching. Sets transfers = [] and netUsdValueTransfers = 0. */
  skipTransfers?: boolean;
  /**
   * When true, clears eventTimeseries and revenue at the start of every run so they are
   * always recomputed from the latest logic. Useful after revenue calculation changes.
   */
  recalculateRevenue?: boolean;
  /**
   * Environment variable name for the RPC URL to use for this asset.
   * Defaults to 'ETHEREUM_RPC_URL'. Set to 'BASE_RPC_URL' for Base chain assets, etc.
   */
  rpcEnvVar?: string;
  /**
   * Chain ID to use when querying the Etherscan v2 API for ERC-20 transfers.
   * Defaults to 1 (Ethereum mainnet). Set to 8453 for Base, etc.
   */
  etherscanChainId?: number;
  /**
   * The wallet address whose balances and transfers are tracked for this asset.
   * Defaults to the global WALLET constant (Ethereum holding wallet).
   * Override for assets on other chains with a different holding wallet.
   */
  walletAddress?: string;
}

/**
 * SparkLend Pool proxy on Ethereum mainnet.
 * Used by the 'aaveNormalizedIncome' pricing module to call getReserveNormalizedIncome().
 */
const SPARK_POOL = ethers.getAddress('0xC13e21B648A5Ee794902342038FF3aDAB66BE987');

const ASSETS: AssetConfig[] = [
  {
    address: ethers.getAddress('0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b'),
    name: 'Syrup USDC',
    pricingModule: { type: 'convertToAssets' },
  },
  {
    address: ethers.getAddress('0x779224df1c756b4edd899854f32a53e8c2b2ce5d'),
    name: 'Spark PYUSD',
    // balanceOf returns the underlying-equivalent amount; Transfer events emit
    // underlying minus balanceIncrease (tiny accrued interest since last action).
    // Both are effectively in underlying units → price = 1.
    pricingModule: { type: 'fixed', price: 1 },
  },
  {
    address: ethers.getAddress('0x00836fe54625be242bcfa286207795405ca4fd10'),
    name: 'Spark.fi USDT Reserve',
    balanceModule: {
      type: 'curveLP',
      targetToken: '0xdac17f958d2ee523a2206206994597c13d831ec7', // Tether USDT
    },
    pricingModule: { type: 'fixed', price: 1 },
    skipTransfers: true,
  },
  {
    address: ethers.getAddress('0xa632d59b9b804a956bfaa9b48af3a1b74808fc1f'),
    name: 'Spark.fi PYUSD Reserve',
    balanceModule: {
      type: 'curveLP',
      targetToken: '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8', // PayPal USD (PYUSD)
    },
    pricingModule: { type: 'fixed', price: 1 },
    skipTransfers: true,
  },
  {
    address: ethers.getAddress('0x4dedf26112b3ec8ec46e7e31ea5e123490b05b8b'),
    name: 'Spark DAI',
    pricingModule: { type: 'fixed', price: 1 },
    skyRevenueModule: {
      type: 'idleLending',
      underlyingAddress: ethers.getAddress('0x6b175474e89094c44da98b954eedeac495271d0f'), // DAI
    },
  },
  {
    address: ethers.getAddress('0xe7df13b8e3d6740fe17cbe928c7334243d86c92f'),
    name: 'Spark USDT',
    pricingModule: { type: 'fixed', price: 1 },
  },
  {
    address: ethers.getAddress('0xc02ab1a5eaa8d1b114ef786d9bde108cd4364359'),
    name: 'Spark USDS',
    pricingModule: { type: 'fixed', price: 1 },
    skyRevenueModule: {
      type: 'idleLending',
      underlyingAddress: ethers.getAddress('0xdC035D45d973E3EC169d2276DDab16f1e407384F'), // USDS
    },
  },
  {
    address: ethers.getAddress('0x5875eee11cf8398102fdad704c9e96607675467a'),
    name: 'Savings USDS (Base)',
    walletAddress: '0x2917956eFF0B5eaF030abDB4EF4296DF775009cA',
    rpcEnvVar: 'BASE_RPC_URL',
    etherscanChainId: 8453,
    pricingModule: {
      type: 'defiLlama',
      blockchain: 'base',
      tokenAddress: '0x5875eee11cf8398102fdad704c9e96607675467a',
    },
    // Sky Revenue for sUSDS = SSR charge only (not SSR + BASE_RATE_PREMIUM).
    // The 0.3% premium above SSR is Prime's profit, not Sky's.
    skyRevenueModule: { type: 'ssrRate' },
  },
];

/** Daily data range: Oct 1 – Oct 31 2025, sampled at 00:00 UTC. */
const RANGE_START    = '2025-10-01T00:00:00Z';
const RANGE_END      = '2025-10-31T00:00:00Z';
const RANGE_START_TS = Math.floor(new Date(RANGE_START).getTime() / 1000);         // inclusive
const RANGE_END_TS   = Math.floor(new Date('2025-11-01T00:00:00Z').getTime() / 1000); // exclusive

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
];

/**
 * ERC-4626 price ABI — used by the 'convertToAssets' pricing module.
 * price = convertToAssets(1e18) / 1e18
 */
const VAULT_ABI = [
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
];

/**
 * Minimal Curve Stableswap-NG ABI.
 * In Stableswap-NG the pool contract IS the LP token (implements ERC-20 directly).
 */
const CURVE_NG_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function get_balances() view returns (uint256[])',
  'function coins(uint256 i) view returns (address)',
  'function N_COINS() view returns (uint256)',
];

/**
 * Aave V3 / SparkLend Pool ABI — minimal interface for the 'aaveNormalizedIncome' pricing module.
 * getReserveNormalizedIncome returns the liquidity index in RAY (1e27 precision).
 * price = normalizedIncome / 1e27  (≈ 1.0 + accrued_interest_since_pool_inception)
 */
const AAVE_POOL_ABI = [
  'function getReserveNormalizedIncome(address asset) view returns (uint256)',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single ERC-20 transfer event returned by Etherscan, filtered to the data range. */
interface TransferRecord {
  blockNumber: number;
  timestamp: number;
  hash: string;
  from: string;
  to: string;
  value: string;        // raw token amount (no decimals applied)
  tokenDecimal: number;
  price: number | null;    // convertToAssets(1e18)/1e18 at the transfer block; null if not yet fetched or N/A
  usdValue: number | null; // value / 10^tokenDecimal * price; null until price is available
}

/**
 * One entry in the event-driven timeseries.
 * Covers three kinds of events:
 *   range-start    — the first 00:00 UTC block in the range
 *   post-transfer  — the block immediately after a wallet transfer
 *   range-end      — the last 00:00 UTC block in the range
 */
interface EventTimeseriesEntry {
  timestamp: number;
  date: string;              // YYYY-MM-DD (approx. for post-transfer events)
  block: number;
  balance: string | null;    // raw on-chain balance
  price: number | null;
  usdValue: number | null;
  label: 'range-start' | 'post-transfer' | 'range-end';
  triggerTxHashes: string[]; // transfer hashes that triggered this event (empty for endpoints)
  preTransferBalance?: string | null; // balanceOf(transferBlock - 1); only for post-transfer
}

interface Revenue {
  /** lastEvent.usdValue − firstEvent.usdValue */
  netUsdValueChange: number | null;
  /** sum(outflow usdValues) − sum(inflow usdValues) across all transfers */
  netUsdValueTransfers: number | null;
  /** netUsdValueChange + netUsdValueTransfers */
  starRevenueEstimate: number | null;
  /**
   * Theoretical SSR yield on the range-start usdValue over the full period,
   * split at SSR.changeBlock using simple interest (rate × fraction_of_year).
   */
  skyRevenueEstimate: number | null;
}

interface TimeseriesEntry {
  timestamp: number;
  date: string;         // YYYY-MM-DD
  block: number;
  balance: string;      // raw on-chain balance as a decimal string (no decimals applied)
  price: number | null; // convertToAssets(1e18) / 1e18; null if not applicable or not yet fetched
  apy: number | null;
  usdValue: number | null;
}

interface TokenData {
  address: string;
  name: string;
  decimals: number | null;
  /**
   * Records which balance module type generated the stored data.
   * When this differs from the current AssetConfig, all balance-derived fields
   * (decimals, timeseries, eventTimeseries, revenue) are invalidated and re-fetched.
   * Transfers are NOT cleared — they come from Etherscan and are module-independent.
   */
  balanceModuleType: string;
  /**
   * Records which pricing module type was used for timeseries / eventTimeseries usdValue.
   * When this differs from the current AssetConfig, timeseries price+usdValue,
   * eventTimeseries, and revenue are invalidated and re-fetched.
   */
  pricingModuleType: string;
  /**
   * Records which pricing module type was used for transfer usdValue calculations.
   * When this differs, transfer price+usdValue, eventTimeseries, and revenue are cleared.
   * Defaults to `pricingModuleType` when there is no separate transferPricingModule.
   */
  transferPricingModuleType: string;
  timeseries: Record<string, TimeseriesEntry>; // keyed by unix timestamp string
  /** ERC-20 transfers involving the wallet in the data range. null = not yet fetched. */
  transfers: TransferRecord[] | null;
  /** Event-driven snapshots: range start, 1 block after each transfer, range end. null = not yet built. */
  eventTimeseries: EventTimeseriesEntry[] | null;
  /** Computed revenue breakdown. null = not yet computed or insufficient price data. */
  revenue: Revenue | null;
}

interface WalletBalancesData {
  ssr: typeof SSR;
  walletAddress: string;
  tokens: Record<string, TokenData>; // keyed by lowercase token address
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function tokenKey(address: string): string {
  return address.toLowerCase();
}

const ONE_18 = 10n ** 18n;

/**
 * price = convertToAssets(1e18) / 1e18
 *
 * rawPrice is the bigint returned by convertToAssets(1e18). We convert to a
 * JS number only at the final step. Because rawPrice is expressed in the
 * underlying asset's atomic units, and we're dividing by 1e18, the resulting
 * float is well within float64 precision for typical vault exchange rates.
 */
function computePrice(rawPrice: bigint): number {
  return Number(rawPrice) / 1e18;
}

/**
 * usdValue = (rawBalance / 10^decimals) * price
 *
 * All intermediate arithmetic is done with BigInt to avoid precision loss for
 * large balances. We scale up by 10^9 before the final Number conversion so
 * we retain 9 significant decimal places in the result.
 */
function computeUsdValue(rawBalance: bigint, rawPrice: bigint, decimals: number): number {
  const RESULT_SCALE = 10n ** 9n;
  const decScale     = 10n ** BigInt(decimals);
  // usdValue * RESULT_SCALE = rawBalance * rawPrice * RESULT_SCALE / (decScale * ONE_18)
  const scaled = rawBalance * rawPrice * RESULT_SCALE / (decScale * ONE_18);
  return Number(scaled) / 1e9;
}

/**
 * Creates a balance resolver for an asset based on its balance module.
 *
 * The function is async because 'curveLP' pre-fetches the target token's coin
 * index and decimals once (both are immutable pool properties) before returning.
 *
 * All `resolve(block)` calls return the raw effective balance as a BigInt in
 * the effective token's atomic units (e.g., USDT 6-decimal units for curveLP).
 */
async function makeBalanceResolver(
  module: BalanceModule | undefined,
  assetAddress: string,
  wallet: string,
  provider: ethers.JsonRpcProvider,
): Promise<{
  resolve: (blockNumber: number) => Promise<bigint>;
  getEffectiveDecimals: () => Promise<number>;
}> {
  if (!module || module.type === 'balanceOf') {
    const erc20 = new ethers.Contract(assetAddress, ERC20_ABI, provider);
    return {
      resolve:              (block) => erc20.balanceOf(wallet, { blockTag: block }) as Promise<bigint>,
      getEffectiveDecimals: async () => Number(await erc20.decimals()),
    };
  }

  // curveLP: the pool contract IS the LP token (Stableswap-NG pattern)
  const pool        = new ethers.Contract(assetAddress, CURVE_NG_ABI, provider);
  const targetLower = module.targetToken.toLowerCase();

  // Pre-fetch coin index (immutable) — iterate coins(0..N-1) to find target
  const nCoins = Number(await pool.N_COINS());
  let targetIdx = -1;
  for (let i = 0; i < nCoins; i++) {
    const coin = ((await pool.coins(i)) as string).toLowerCase();
    if (coin === targetLower) { targetIdx = i; break; }
  }
  if (targetIdx === -1) {
    throw new Error(
      `Target token ${module.targetToken} not found in Curve pool ${assetAddress}`,
    );
  }
  const resolvedIdx = targetIdx;

  // Pre-fetch target token decimals (immutable)
  const targetErc20    = new ethers.Contract(module.targetToken, ERC20_ABI, provider);
  const targetDecimals = Number(await targetErc20.decimals());

  return {
    resolve: async (blockNumber: number): Promise<bigint> => {
      // Batch the three reads for efficiency
      const [lpBalance, lpTotalSupply, poolBalances] = await Promise.all([
        pool.balanceOf(wallet,  { blockTag: blockNumber }) as Promise<bigint>,
        pool.totalSupply(       { blockTag: blockNumber }) as Promise<bigint>,
        pool.get_balances(      { blockTag: blockNumber }) as Promise<bigint[]>,
      ]);
      if (lpTotalSupply === 0n) return 0n;
      // Proportional share: all BigInt arithmetic to preserve precision
      return (poolBalances[resolvedIdx] * lpBalance) / lpTotalSupply;
    },
    getEffectiveDecimals: async () => targetDecimals,
  };
}

/**
 * Returns a uniform price resolver for an asset.
 * All callers await `resolve(blockNumber, timestamp)` to get a rawPrice bigint
 * scaled by 1e18, suitable for `computePrice()` and `computeUsdValue()`.
 *
 *  convertToAssets      — on-chain call at the given block (timestamp ignored)
 *  fixed                — constant, no RPC call (both arguments ignored)
 *  aaveNormalizedIncome — on-chain call at the given block (timestamp ignored)
 *  defiLlama            — DeFiLlama historical price lookup by timestamp (block ignored)
 */
function makePriceResolver(
  module: PricingModule,
  provider: ethers.JsonRpcProvider,
  address: string,
): { resolve: (blockNumber: number, timestamp: number) => Promise<bigint> } {
  if (module.type === 'fixed') {
    const rawFixed = BigInt(Math.round(module.price * 1e18));
    return { resolve: async (_block, _ts) => rawFixed };
  }

  if (module.type === 'aaveNormalizedIncome') {
    const pool = new ethers.Contract(module.poolAddress, AAVE_POOL_ABI, provider);
    return {
      resolve: async (blockNumber: number, _ts: number): Promise<bigint> => {
        // getReserveNormalizedIncome returns the liquidity index in RAY (1e27).
        // Divide by 1e9 to rescale to 1e18, the unit expected by computePrice().
        const income = await pool.getReserveNormalizedIncome(
          module.underlyingAsset,
          { blockTag: blockNumber },
        ) as bigint;
        return income / 1_000_000_000n;
      },
    };
  }

  if (module.type === 'defiLlama') {
    return {
      resolve: async (_blockNumber: number, timestamp: number): Promise<bigint> => {
        const price = await getDefiLlamaPriceByTimestamp(
          module.tokenAddress,
          module.blockchain,
          timestamp,
          false, // logging enabled
          3,     // search up to 3 days back if exact timestamp unavailable
        );
        return BigInt(Math.round(price * 1e18));
      },
    };
  }

  const contract = new ethers.Contract(address, VAULT_ABI, provider);
  return {
    resolve: (blockNumber: number, _ts: number) =>
      contract.convertToAssets(ONE_18, { blockTag: blockNumber }) as Promise<bigint>,
  };
}

/**
 * Estimates the SSR yield earned on `initialUsdValue` over the period
 * [blockResults[0].block, blockResults[last].block], correctly splitting the
 * calculation at SSR.changeBlock where the rate changes.
 *
 * Uses simple interest (rate × fraction_of_year) for each sub-period, which
 * is accurate for the short durations involved.
 */
/**
 * Computes the theoretical Sky Revenue charge by summing daily balance × daily rate
 * across every snapshot in `blockResults`.
 *
 * For each day:
 *   rate    = ssrRate + BASE_RATE_PREMIUM  (default)
 *           = ssrRate                       (when useSSROnly = true, e.g. sUSDS positions)
 *   interest = usdValue_at_day × (rate / 365.25) × idleFactor_at_block
 *
 * idleFactors (optional) — map of blockNumber → (1 − underlyingBalance/totalSupply).
 * If absent for a given block, a factor of 1.0 is used (no idle adjustment).
 *
 * useSSROnly (optional, default false) — when true, uses SSR alone as the rate instead
 * of SSR + BASE_RATE_PREMIUM. Used for USDS Savings assets per the Primary Methodology.
 *
 * Returns null if any daily entry is missing or has a null usdValue.
 */
function computeSkyRevenueEstimate(
  timeseries: Record<string, TimeseriesEntry>,
  ssr: typeof SSR,
  blockResults: { block: number; date: string }[],
  idleFactors?: Map<number, number>,
  useSSROnly = false,
): number | null {
  const DAYS_PER_YEAR = 365.25;

  let total = 0;
  for (const blockResult of blockResults) {
    const ts    = Math.floor(new Date(blockResult.date).getTime() / 1000);
    const entry = timeseries[String(ts)];
    if (!entry || entry.usdValue === null) return null;

    const ssrRate = blockResult.block < ssr.changeBlock ? ssr.before : ssr.atOrAfter;
    const rate    = useSSROnly ? ssrRate : ssrRate + BASE_RATE_PREMIUM;
    const idle    = idleFactors?.get(blockResult.block) ?? 1;
    total += entry.usdValue * rate / DAYS_PER_YEAR * idle;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Etherscan helpers
// ---------------------------------------------------------------------------

interface EtherscanTokenTxResult {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  tokenDecimal: string;
}

interface EtherscanResponse {
  status: string;
  message: string;
  result: EtherscanTokenTxResult[] | string;
}

/**
 * Fetches all ERC-20 transfers for `tokenAddress` ↔ `walletAddress` from
 * Etherscan (v2 API), then filters to [startTs, endTs).
 * chainId defaults to 1 (Ethereum mainnet); pass 8453 for Base, etc.
 */
async function fetchTransfers(
  apiKey: string,
  tokenAddress: string,
  walletAddress: string,
  startTs: number,
  endTs: number,
  chainId: number = 1,
): Promise<TransferRecord[]> {
  const url = new URL('https://api.etherscan.io/v2/api');
  url.searchParams.set('chainid', String(chainId));
  url.searchParams.set('module', 'account');
  url.searchParams.set('action', 'tokentx');
  url.searchParams.set('contractaddress', tokenAddress);
  url.searchParams.set('address', walletAddress);
  url.searchParams.set('sort', 'asc');
  url.searchParams.set('apikey', apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Etherscan HTTP error: ${res.status} ${res.statusText}`);

  const json = await res.json() as EtherscanResponse;

  if (json.status !== '1') {
    // "No transactions found" is a normal empty result, not an error
    if (json.message === 'No transactions found') return [];
    throw new Error(`Etherscan API error: ${json.message} — ${JSON.stringify(json.result)}`);
  }

  return (json.result as EtherscanTokenTxResult[])
    .map(r => ({
      blockNumber:  Number(r.blockNumber),
      timestamp:    Number(r.timeStamp),
      hash:         r.hash,
      from:         r.from.toLowerCase(),
      to:           r.to.toLowerCase(),
      value:        r.value,
      tokenDecimal: Number(r.tokenDecimal),
      price:        null,
      usdValue:     null,
    }))
    .filter(r => r.timestamp >= startTs && r.timestamp < endTs);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const etherscanKey = process.env.ETHERSCAN_API_KEY;
  if (!etherscanKey) throw new Error('ETHERSCAN_API_KEY not set in .env');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const outPath   = path.join(__dirname, '..', '..', 'data', 'wallet-balances.json');

  // Load existing data or initialise fresh
  let data: WalletBalancesData;
  if (fs.existsSync(outPath)) {
    data = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as WalletBalancesData;
    console.log(`Loaded existing data from ${outPath}`);
  } else {
    data = { ssr: SSR, walletAddress: WALLET, tokens: {} };
    console.log('No existing data file found — starting fresh');
  }

  // Always refresh the hardcoded SSR and wallet fields
  data.ssr           = SSR;
  data.walletAddress = WALLET;

  // Per-chain provider / dater / blockResults caches (keyed by env var name).
  // Providers are created lazily so missing env vars only throw for chains actually used.
  const providerCache     = new Map<string, ethers.JsonRpcProvider>();
  const blockResultsCache = new Map<string, { block: number; date: string }[]>();

  function getProvider(envVar: string): ethers.JsonRpcProvider {
    if (!providerCache.has(envVar)) {
      const url = process.env[envVar];
      if (!url) throw new Error(`${envVar} not set in .env`);
      providerCache.set(envVar, new ethers.JsonRpcProvider(url));
    }
    return providerCache.get(envVar)!;
  }

  async function getBlockResults(envVar: string): Promise<{ block: number; date: string }[]> {
    if (!blockResultsCache.has(envVar)) {
      const provider = getProvider(envVar);
      const dater    = new EthDater(provider);
      console.log(`\nResolving daily blocks for ${envVar} (${RANGE_START} → ${RANGE_END})...`);
      const results  = await dater.getEvery('days', RANGE_START, RANGE_END, 1, false);
      console.log(`Resolved ${results.length} blocks: ${results[0].block} → ${results[results.length - 1].block}`);
      blockResultsCache.set(envVar, results);
    }
    return blockResultsCache.get(envVar)!;
  }

  for (const asset of ASSETS) {
    const key            = tokenKey(asset.address);
    const assetWallet    = asset.walletAddress ?? WALLET;

    const currentBalanceModuleType         = asset.balanceModule?.type ?? 'balanceOf';
    const currentPricingModuleType         = asset.pricingModule?.type ?? 'none';
    const currentTransferPricingModuleType = (asset.transferPricingModule ?? asset.pricingModule)?.type ?? 'none';

    // Initialise token entry if it doesn't exist yet
    if (!data.tokens[key]) {
      data.tokens[key] = {
        address: asset.address,
        name: asset.name,
        decimals: null,
        balanceModuleType:         currentBalanceModuleType,
        pricingModuleType:         currentPricingModuleType,
        transferPricingModuleType: currentTransferPricingModuleType,
        timeseries: {},
        transfers: null,
        eventTimeseries: null,
        revenue: null,
      };
    }

    // Migrate entries created before these tracking fields existed
    const tokenData  = data.tokens[key];
    tokenData.eventTimeseries  ??= null;
    tokenData.revenue          ??= null;
    tokenData.balanceModuleType ??= 'balanceOf';
    // For pricingModuleType: default to current unless the stored data is known to be stale.
    // Any token that previously had no separate transferPricingModule defaults to current type
    // (no unnecessary re-fetch). For transferPricingModuleType, default to 'unknown' when the
    // current type is 'aaveNormalizedIncome' so stale 'fixed' prices are cleared.
    tokenData.pricingModuleType         ??= currentPricingModuleType;
    tokenData.transferPricingModuleType ??= (
      currentTransferPricingModuleType === 'aaveNormalizedIncome' ? 'unknown' : currentTransferPricingModuleType
    );

    // Balance module changed → invalidate all balance-derived data (transfers kept).
    if (tokenData.balanceModuleType !== currentBalanceModuleType) {
      console.log(`[${asset.name}] Balance module changed (${tokenData.balanceModuleType} → ${currentBalanceModuleType}); clearing stale balance data.`);
      tokenData.decimals          = null;
      tokenData.timeseries        = {};
      tokenData.eventTimeseries   = null;
      tokenData.revenue           = null;
      tokenData.balanceModuleType = currentBalanceModuleType;
    }

    // Pricing module changed → invalidate timeseries price+usdValue, eventTimeseries, revenue.
    // Balance values and raw transfer records are kept.
    if (tokenData.pricingModuleType !== currentPricingModuleType) {
      console.log(`[${asset.name}] Pricing module changed (${tokenData.pricingModuleType} → ${currentPricingModuleType}); clearing stale timeseries price data.`);
      for (const entry of Object.values(tokenData.timeseries)) {
        entry.price    = null;
        entry.usdValue = null;
      }
      tokenData.eventTimeseries   = null;
      tokenData.revenue           = null;
      tokenData.pricingModuleType = currentPricingModuleType;
    }

    // Transfer pricing module changed → invalidate transfer price+usdValue, eventTimeseries, revenue.
    if (tokenData.transferPricingModuleType !== currentTransferPricingModuleType) {
      console.log(`[${asset.name}] Transfer pricing module changed (${tokenData.transferPricingModuleType} → ${currentTransferPricingModuleType}); clearing stale transfer price data.`);
      if (tokenData.transfers) {
        for (const tx of tokenData.transfers) {
          tx.price    = null;
          tx.usdValue = null;
        }
      }
      tokenData.eventTimeseries           = null;
      tokenData.revenue                   = null;
      tokenData.transferPricingModuleType = currentTransferPricingModuleType;
    }

    // recalculateRevenue flag → always rebuild eventTimeseries and revenue from scratch.
    if (asset.recalculateRevenue) {
      tokenData.eventTimeseries = null;
      tokenData.revenue         = null;
    }

    const rpcEnvVar       = asset.rpcEnvVar ?? 'ETHEREUM_RPC_URL';
    const assetProvider   = getProvider(rpcEnvVar);
    const assetBlockResults = await getBlockResults(rpcEnvVar);

    const balanceResolver = await makeBalanceResolver(
      asset.balanceModule, asset.address, assetWallet, assetProvider,
    );
    const priceResolver         = asset.pricingModule
      ? makePriceResolver(asset.pricingModule, assetProvider, asset.address)
      : null;
    // Transfer pricing falls back to the main price resolver when no separate module is configured.
    const transferPriceResolver = asset.transferPricingModule
      ? makePriceResolver(asset.transferPricingModule, assetProvider, asset.address)
      : priceResolver;

    // Fetch effective token decimals once and cache them.
    // For curveLP assets this is the target token's decimals (e.g. USDT = 6),
    // not the LP token's decimals.
    if (tokenData.decimals === null) {
      process.stdout.write(`[${asset.name}] Fetching decimals... `);
      tokenData.decimals = await balanceResolver.getEffectiveDecimals();
      console.log(`${tokenData.decimals}`);
    }

    console.log(`[${asset.name}] (decimals: ${tokenData.decimals})`);

    for (const blockResult of assetBlockResults) {
      // Timestamps from EthDater use the date string; normalise to unix seconds
      const ts    = Math.floor(new Date(blockResult.date).getTime() / 1000);
      const tsKey = String(ts);
      const label = blockResult.date.slice(0, 10);

      const existing    = tokenData.timeseries[tsKey];
      // An entry created before the `price` field existed will have price === undefined
      const needsBalance = !existing;
      const needsPrice   = !!priceResolver && (existing?.price == null);

      if (!needsBalance && !needsPrice) {
        console.log(`  ${label}  fully cached — skipping`);
        continue;
      }

      // ---- fetch balance (only when the entry doesn't exist yet) ----
      if (needsBalance) {
        process.stdout.write(`  ${label}  block ${blockResult.block}  balance...`);
        try {
          const rawBalance = await balanceResolver.resolve(blockResult.block);
          tokenData.timeseries[tsKey] = {
            timestamp: ts,
            date:      label,
            block:     blockResult.block,
            balance:   rawBalance.toString(),
            price:     null,
            apy:       null,
            usdValue:  null,
          };
          process.stdout.write(` ${rawBalance.toString()}`);
        } catch (err) {
          process.stdout.write(` WARN(balance): ${err}\n`);
          await sleep(100);
          continue; // skip price fetch if balance failed
        }
      }

      // ---- fetch price + usdValue (only for price-enabled assets) ----
      if (needsPrice) {
        process.stdout.write(`  price...`);
        try {
          const rawPrice = await priceResolver!.resolve(blockResult.block, ts);
          const price  = computePrice(rawPrice);
          const entry  = tokenData.timeseries[tsKey];
          entry.price  = price;

          if (tokenData.decimals !== null && entry.balance !== null) {
            entry.usdValue = computeUsdValue(BigInt(entry.balance), rawPrice, tokenData.decimals);
          }
          process.stdout.write(` ${price.toFixed(6)}`);
        } catch (err) {
          process.stdout.write(` WARN(price): ${err}`);
        }
      }

      process.stdout.write('\n');
      await sleep(100);
    }

    // ---- fetch Etherscan transfers (once per token) ----
    if (tokenData.transfers === null || tokenData.transfers === undefined) {
      if (asset.skipTransfers) {
        tokenData.transfers = [];
        console.log(`[${asset.name}] Transfers skipped (skipTransfers flag set) — netUsdValueTransfers will be 0`);
      } else {
        process.stdout.write(`[${asset.name}] Fetching transfers from Etherscan... `);
        try {
          tokenData.transfers = await fetchTransfers(
            etherscanKey,
            asset.address,
            assetWallet,
            RANGE_START_TS,
            RANGE_END_TS,
            asset.etherscanChainId ?? 1,
          );
          // Initialise price/usdValue fields on freshly-fetched records
          for (const tx of tokenData.transfers) {
            tx.price    = null;
            tx.usdValue = null;
          }
          console.log(`${tokenData.transfers.length} transfer(s) in range`);
        } catch (err) {
          console.log(`WARN: ${err}`);
        }
      }
    } else {
      console.log(`[${asset.name}] Transfers already cached (${tokenData.transfers.length})`);
    }

    // SKIPPED: per-transfer price/usdValue fetching — tx.usdValue is no longer used in
    // netUsdValueTransfers (which now uses eventTimeseries preTransferBalance deltas).
    // if (transferPriceResolver && tokenData.transfers ...) { ... }

    // ---- build / refresh eventTimeseries ----
    {
      // Determine whether we already have a fully-populated eventTimeseries.
      // post-transfer entries must also have preTransferBalance set.
      const evFullyCached =
        Array.isArray(tokenData.eventTimeseries) &&
        tokenData.eventTimeseries.length > 0 &&
        tokenData.eventTimeseries.every(e =>
          e.balance !== null &&
          (!priceResolver || e.price !== null) &&
          (e.label !== 'post-transfer' || (e.preTransferBalance !== null && e.preTransferBalance !== undefined)),
        );

      if (evFullyCached) {
        console.log(`[${asset.name}] eventTimeseries already cached (${tokenData.eventTimeseries!.length} entries)`);
      } else {
        // --- build the ordered list of (block, timestamp, label, hashes) events ---
        type EvSpec = {
          block: number; timestamp: number;
          label: EventTimeseriesEntry['label'];
          hashes: string[];
          transferBlock?: number; // the actual transfer block (block - 1 for post-transfer)
        };

        const firstResult = assetBlockResults[0];
        const lastResult  = assetBlockResults[assetBlockResults.length - 1];
        const firstTs     = Math.floor(new Date(firstResult.date).getTime() / 1000);
        const lastTs      = Math.floor(new Date(lastResult.date).getTime() / 1000);

        // Use a Map keyed by block number so duplicate (blockNumber+1) entries are merged
        const evMap = new Map<number, EvSpec>();

        evMap.set(firstResult.block, {
          block: firstResult.block, timestamp: firstTs,
          label: 'range-start', hashes: [],
        });

        for (const tx of (tokenData.transfers ?? [])) {
          const b = tx.blockNumber + 1;
          if (evMap.has(b)) {
            evMap.get(b)!.hashes.push(tx.hash);
          } else {
            evMap.set(b, {
              block: b, timestamp: tx.timestamp,
              label: 'post-transfer', hashes: [tx.hash],
              transferBlock: tx.blockNumber,
            });
          }
        }

        // Range-end block: if it collides with an existing entry, upgrade its label
        if (evMap.has(lastResult.block)) {
          evMap.get(lastResult.block)!.label = 'range-end';
        } else {
          evMap.set(lastResult.block, {
            block: lastResult.block, timestamp: lastTs,
            label: 'range-end', hashes: [],
          });
        }

        const events = Array.from(evMap.values()).sort((a, b) => a.block - b.block);

        // Index existing entries by block for partial-progress reuse
        const existingByBlock = new Map<number, EventTimeseriesEntry>(
          (tokenData.eventTimeseries ?? []).map(e => [e.block, e]),
        );

        const rebuilt: EventTimeseriesEntry[] = [];
        console.log(`[${asset.name}] Building eventTimeseries (${events.length} events)...`);

        for (const ev of events) {
          const cached    = existingByBlock.get(ev.block);
          const needsBal  = !cached || cached.balance === null;
          const needsPri  = !!priceResolver && (!cached || cached.price === null);
          const needsPreBal = ev.label === 'post-transfer'
            && (!cached || cached.preTransferBalance === undefined || cached.preTransferBalance === null);

          if (!needsBal && !needsPri && !needsPreBal && cached) {
            rebuilt.push(cached);
            continue;
          }

          const entry: EventTimeseriesEntry = cached ?? {
            timestamp:        ev.timestamp,
            date:             new Date(ev.timestamp * 1000).toISOString().slice(0, 10),
            block:            ev.block,
            balance:          null,
            price:            null,
            usdValue:         null,
            label:            ev.label,
            triggerTxHashes:  ev.hashes,
          };

          process.stdout.write(`  block ${ev.block} [${ev.label}]  balance...`);

          if (needsBal) {
            try {
              const rawBal = await balanceResolver.resolve(ev.block);
              entry.balance = rawBal.toString();
              process.stdout.write(` ${rawBal.toString()}`);
            } catch (err) {
              process.stdout.write(` WARN(balance): ${err}\n`);
              rebuilt.push(entry);
              await sleep(100);
              continue;
            }
          }

          if (needsPreBal && ev.transferBlock !== undefined) {
            process.stdout.write(`  preBal(${ev.transferBlock - 1})...`);
            try {
              const preBal = await balanceResolver.resolve(ev.transferBlock - 1);
              entry.preTransferBalance = preBal.toString();
              process.stdout.write(` ${preBal.toString()}`);
            } catch (err) {
              process.stdout.write(` WARN(preBalance): ${err}`);
            }
          }

          if (needsPri) {
            process.stdout.write(`  price...`);
            try {
              const rawPrice = await priceResolver!.resolve(ev.block, ev.timestamp);
              entry.price = computePrice(rawPrice);
              if (entry.balance !== null && tokenData.decimals !== null) {
                entry.usdValue = computeUsdValue(
                  BigInt(entry.balance), rawPrice, tokenData.decimals,
                );
              }
              process.stdout.write(` ${entry.price.toFixed(6)}`);
            } catch (err) {
              process.stdout.write(` WARN(price): ${err}`);
            }
          }

          process.stdout.write('\n');
          rebuilt.push(entry);
          await sleep(100);
        }

        tokenData.eventTimeseries = rebuilt;

        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
        console.log(`  eventTimeseries saved (${rebuilt.length} entries)`);
      }
    }

    // ---- compute revenue ----
    {
      const evts      = tokenData.eventTimeseries;
      const transfers = tokenData.transfers;

      // Revenue requires a price-enabled asset with a complete eventTimeseries
      if (priceResolver && evts && evts.length >= 2 && transfers) {
        const rangeStartEvt = evts.find(e => e.label === 'range-start');
        const rangeEndEvt   = evts.find(e => e.label === 'range-end');
        if (!rangeStartEvt || !rangeEndEvt) throw new Error(`Missing range-start or range-end event for ${asset.name}`);

        const netUsdValueChange =
          rangeStartEvt.usdValue !== null && rangeEndEvt.usdValue !== null
            ? rangeEndEvt.usdValue - rangeStartEvt.usdValue
            : null;

        // Compute net USD value of transfers using preTransferBalance.
        // For each post-transfer event we compare balanceOf(transferBlock + 1)
        // with balanceOf(transferBlock - 1) (stored as preTransferBalance).
        // The delta isolates the actual transfer effect — the ~2-block interest
        // gap (~24 sec) is negligible.  This avoids:
        //  1. SparkLend balanceIncrease distortion in raw Transfer event values.
        //  2. Interest accumulation between widely-spaced events inflating deltas.
        //  3. Price appreciation on existing balance for variable-price tokens.
        const sorted = [...evts].sort((a, b) => a.block - b.block);
        let netUsdValueTransfers: number | null = null;
        const postTransferEvents = sorted.filter(
          e => e.label === 'post-transfer' && e.block <= rangeEndEvt.block,
        );
        const allReady = postTransferEvents.every(
          e => e.balance !== null && e.preTransferBalance !== null && e.preTransferBalance !== undefined && e.price !== null,
        );

        if (allReady && tokenData.decimals !== null) {
          const dec = tokenData.decimals;
          let netTransferUsd = 0;
          for (const ev of postTransferEvents) {
            const balDelta = BigInt(ev.balance!) - BigInt(ev.preTransferBalance!);
            const tokenAmount = Number(balDelta) / 10 ** dec;
            netTransferUsd += tokenAmount * ev.price!;
          }
          // netTransferUsd is inflows − outflows; flip sign so outflows are positive
          netUsdValueTransfers = -netTransferUsd;
        }

        const starRevenueEstimate =
          netUsdValueChange !== null && netUsdValueTransfers !== null
            ? netUsdValueChange + netUsdValueTransfers
            : null;

        // Pre-fetch idle lending factors if the asset uses the idleLending sky-revenue module.
        let idleFactors: Map<number, number> | undefined;
        if (asset.skyRevenueModule?.type === 'idleLending') {
          const underlying = new ethers.Contract(
            asset.skyRevenueModule.underlyingAddress, ERC20_ABI, assetProvider,
          );
          const spToken = new ethers.Contract(asset.address, ERC20_ABI, assetProvider);
          idleFactors = new Map();
          console.log(`[${asset.name}] Fetching idle lending factors for ${assetBlockResults.length} blocks...`);
          await Promise.all(assetBlockResults.map(async (br) => {
            const [idleBal, supply] = await Promise.all([
              underlying.balanceOf(asset.address, { blockTag: br.block }) as Promise<bigint>,
              spToken.totalSupply({ blockTag: br.block }) as Promise<bigint>,
            ]);
            const factor = supply === 0n ? 1 : 1 - Number(idleBal) / Number(supply);
            idleFactors!.set(br.block, factor);
          }));
        }

        // SSR theoretical yield: sum of daily (balance × rate / 365.25 × idleFactor)
        // sUSDS positions use SSR only (no BASE_RATE_PREMIUM) per the Primary Methodology.
        const skyRevenueEstimate = computeSkyRevenueEstimate(
          tokenData.timeseries, data.ssr, assetBlockResults, idleFactors,
          asset.skyRevenueModule?.type === 'ssrRate',
        );

        tokenData.revenue = { netUsdValueChange, netUsdValueTransfers, starRevenueEstimate, skyRevenueEstimate };
        console.log(
          `[${asset.name}] Revenue:` +
          `  netUsdValueChange=${netUsdValueChange?.toFixed(2) ?? 'null'}` +
          `  netUsdValueTransfers=${netUsdValueTransfers?.toFixed(2) ?? 'null'}` +
          `  starRevenueEstimate=${starRevenueEstimate?.toFixed(2) ?? 'null'}` +
          `  skyRevenueEstimate=${skyRevenueEstimate?.toFixed(2) ?? 'null'}`,
        );
      } else if (!priceResolver) {
        tokenData.revenue = { netUsdValueChange: null, netUsdValueTransfers: null, starRevenueEstimate: null, skyRevenueEstimate: null };
      }
    }

    // Persist after each asset so partial progress is never lost
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`  → saved\n`);
  }

  console.log(`Done. Data written to ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
