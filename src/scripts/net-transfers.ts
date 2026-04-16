/**
 * Reads data/wallet-balances.json and, for each token, calculates net
 * transfer flow involving the holding wallet over the stored range.
 *
 * For every transfer record:
 *   - from === wallet  →  outflow  (wallet sent tokens out)
 *   - to   === wallet  →  inflow   (wallet received tokens)
 *
 * Output per token:
 *   - inflow count + total
 *   - outflow count + total
 *   - net  (inflow − outflow, negative means the wallet is a net sender)
 *
 * Usage:
 *   npm run net-transfers
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath  = path.join(__dirname, '..', '..', 'data', 'wallet-balances.json');

if (!fs.existsSync(dataPath)) {
  console.error(`Data file not found: ${dataPath}`);
  console.error('Run `npm run fetch-wallet-balances` first.');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
const walletAddress: string = (data.walletAddress as string).toLowerCase();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAmount(rawBigInt: bigint, decimals: number): string {
  if (decimals === 0) return rawBigInt.toString();

  const scale  = 10n ** BigInt(decimals);
  const whole  = rawBigInt / scale;
  const frac   = rawBigInt % scale;

  // Pad fractional part to `decimals` digits, then trim trailing zeros
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
}

function sign(n: bigint): string {
  if (n > 0n) return `+${formatAmount(n, 0)}`;
  if (n < 0n) return `-${formatAmount(-n, 0)}`;
  return '0';
}

// ---------------------------------------------------------------------------
// Compute and print
// ---------------------------------------------------------------------------

const tokens = data.tokens as Record<string, {
  name: string;
  decimals: number | null;
  transfers: Array<{ from: string; to: string; value: string; timestamp: number }> | null;
}>;

console.log(`Wallet: ${data.walletAddress}\n`);
console.log('='.repeat(72));

for (const [tokenKey, token] of Object.entries(tokens)) {
  const decimals = token.decimals ?? 0;
  const transfers = token.transfers;

  console.log(`\n${token.name}  (${tokenKey})`);

  if (!transfers || transfers.length === 0) {
    console.log('  No transfers in range.');
    continue;
  }

  let inflowTotal  = 0n;
  let outflowTotal = 0n;
  let inflowCount  = 0;
  let outflowCount = 0;

  for (const tx of transfers) {
    const value = BigInt(tx.value);

    if (tx.to.toLowerCase() === walletAddress) {
      inflowTotal += value;
      inflowCount++;
    } else if (tx.from.toLowerCase() === walletAddress) {
      outflowTotal += value;
      outflowCount++;
    }
    // transfers where neither address is the wallet are ignored
  }

  const net = inflowTotal - outflowTotal;

  const pad = (s: string) => s.padStart(30);

  console.log(`  Inflows  (${String(inflowCount).padStart(3)} txns):  ${pad(formatAmount(inflowTotal, decimals))}`);
  console.log(`  Outflows (${String(outflowCount).padStart(3)} txns):  ${pad(formatAmount(outflowTotal, decimals))}`);
  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  Net flow               :  ${pad(formatAmount(net < 0n ? -net : net, decimals))}  (${net < 0n ? 'net outflow' : net > 0n ? 'net inflow' : 'neutral'})`);
}

console.log('\n' + '='.repeat(72));
