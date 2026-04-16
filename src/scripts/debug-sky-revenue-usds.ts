/**
 * Debug script: trace the skyRevenueEstimate calculation for Spark USDS step-by-step.
 * Makes live RPC calls to fetch the idle lending factors (USDS balance / spUSDS totalSupply)
 * at each daily block, and logs every intermediate value.
 */

import * as fs from 'fs';
import { ethers } from 'ethers';
import 'dotenv/config';

const DATA_PATH = 'd:/Dev/settle-dune-dash/data/wallet-balances.json';

const SPARK_USDS_ADDRESS  = ethers.getAddress('0xc02ab1a5eaa8d1b114ef786d9bde108cd4364359');
const USDS_ADDRESS        = ethers.getAddress('0xdC035D45d973E3EC169d2276DDab16f1e407384F');

const BASE_RATE_PREMIUM = 0.003;
const DAYS_PER_YEAR     = 365.25;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
];

async function main() {
  const rpcUrl = process.env.ETHEREUM_RPC_URL;
  if (!rpcUrl) throw new Error('ETHEREUM_RPC_URL not set in .env');
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

  // Find Spark USDS token data
  const tokenKey = Object.keys(data.tokens).find(
    k => k.toLowerCase() === SPARK_USDS_ADDRESS.toLowerCase(),
  );
  if (!tokenKey) throw new Error('Spark USDS not found in wallet-balances.json');
  const tok = data.tokens[tokenKey];

  const ssr: { before: number; atOrAfter: number; changeBlock: number } = data.ssr;
  console.log('SSR config:', ssr);
  console.log('BASE_RATE_PREMIUM:', BASE_RATE_PREMIUM);
  console.log('Stored skyRevenueEstimate:', tok.revenue?.skyRevenueEstimate);
  console.log('Stored decimals:', tok.decimals);
  console.log();

  const spUsds  = new ethers.Contract(SPARK_USDS_ADDRESS, ERC20_ABI, provider);
  const usds    = new ethers.Contract(USDS_ADDRESS, ERC20_ABI, provider);

  // Fetch on-chain decimals for both tokens to verify
  const [spUsdsDecimals, usdsDecimals] = await Promise.all([
    spUsds.decimals() as Promise<bigint>,
    usds.decimals()   as Promise<bigint>,
  ]);
  console.log('On-chain spUSDS decimals:', Number(spUsdsDecimals));
  console.log('On-chain USDS decimals:  ', Number(usdsDecimals));
  console.log();

  // Build ordered list of daily block results from the timeseries
  const blockResults = Object.values(tok.timeseries as Record<string, {
    timestamp: number; date: string; block: number; balance: string | null; usdValue: number | null;
  }>)
    .sort((a, b) => a.block - b.block);

  console.log(`Processing ${blockResults.length} daily entries...\n`);
  console.log(
    ['Date', 'Block', 'Balance (raw)', 'usdValue', 'SSR rate', 'baseRate',
     'USDS in contract (raw)', 'spUSDS totalSupply (raw)',
     'USDS dec', 'spUSDS dec', 'idleFactor', 'dailyYield'].join('\t'),
  );

  let runningTotal = 0;
  for (const entry of blockResults) {
    if (!entry.block) continue;

    const ssrRate  = entry.block < ssr.changeBlock ? ssr.before : ssr.atOrAfter;
    const baseRate = ssrRate + BASE_RATE_PREMIUM;

    // Fetch live idle lending values
    const [usdsBal, spSupply] = await Promise.all([
      usds.balanceOf(SPARK_USDS_ADDRESS, { blockTag: entry.block })  as Promise<bigint>,
      spUsds.totalSupply({ blockTag: entry.block })                   as Promise<bigint>,
    ]);

    const idleFactor = spSupply === 0n
      ? 1
      : 1 - Number(usdsBal) / Number(spSupply);

    const dailyYield = (entry.usdValue ?? 0) * baseRate / DAYS_PER_YEAR * idleFactor;
    runningTotal += dailyYield;

    console.log([
      entry.date,
      entry.block,
      entry.balance ?? 'null',
      entry.usdValue?.toFixed(2) ?? 'null',
      ssrRate,
      baseRate,
      usdsBal.toString(),
      spSupply.toString(),
      Number(usdsDecimals),
      Number(spUsdsDecimals),
      idleFactor.toFixed(6),
      dailyYield.toFixed(2),
    ].join('\t'));
  }

  console.log('\n--- TOTAL skyRevenueEstimate (this script):', runningTotal.toFixed(2));
  console.log('--- Stored skyRevenueEstimate:              ', tok.revenue?.skyRevenueEstimate?.toFixed(2) ?? 'null');
}

main().catch(err => { console.error(err); process.exit(1); });
