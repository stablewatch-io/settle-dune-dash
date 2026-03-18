/**
 * Fetches hourly totalAssets / totalSupply for Morpho v2 vaults and saves
 * the results to data/share-prices.csv.
 *
 * Usage:
 *   npm run fetch-share-prices
 *
 * Requires .env:
 *   ETHEREUM_RPC_URL — Alchemy (or any archive node) RPC endpoint
 */

import { ethers } from 'ethers';
import { config } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import EthDater from 'ethereum-block-by-date';
import vaultAbi from '../abis/morpho-vault-v2.json' assert { type: 'json' };

config();

const VAULTS = [
  { address: ethers.getAddress('0xf42bca228d9bd3e2f8ee65fec3d21de1063882d4'), name: 'Morpho USDS Risk Capital' },
  { address: ethers.getAddress('0xe15fcc81118895b67b6647bbd393182df44e11e0'), name: 'Morpho USDS Flagship' },
  { address: ethers.getAddress('0xe41a0583334f0dc4e023acd0bfef3667f6fe0597'), name: 'Spark USDS Vault' },
];

// Collect hourly data from 2026-03-01 00:00 UTC
const FROM_TS = 1772323200;

// ---------------------------------------------------------------------------

function tsToIso(ts: number): string {
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------

async function main() {
  const rpcUrl = process.env.ETHEREUM_RPC_URL;
  if (!rpcUrl) throw new Error('ETHEREUM_RPC_URL not set in .env');

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const dater    = new EthDater(provider);
  const toTs     = Math.floor(Date.now() / 1000);

  const fromDate = new Date(FROM_TS * 1000);
  const toDate   = new Date(toTs * 1000);

  console.log(`Resolving hourly blocks (${tsToIso(FROM_TS)} → ${tsToIso(toTs)}) ...`);

  const blockResults: { date: string; block: number; timestamp: number }[] =
    await dater.getEvery('hours', fromDate, toDate, 1, false);

  const timestamps   = blockResults.map(r => Math.floor(new Date(r.date).getTime() / 1000));
  const blockNumbers = blockResults.map(r => r.block);
  console.log(`Resolved ${blockNumbers.length} blocks: ${blockNumbers[0]} → ${blockNumbers[blockNumbers.length - 1]}\n`);

  const rows: string[] = ['vault_address,hour,block_number,total_assets,total_supply,share_price'];

  for (const vault of VAULTS) {
    console.log(`[${vault.name}]`);
    const contract = new ethers.Contract(vault.address, vaultAbi, provider);

    for (let i = 0; i < timestamps.length; i++) {
      const blockNumber = blockNumbers[i];
      const hour        = tsToIso(timestamps[i]);

      if (i % 24 === 0) process.stdout.write(`  ${hour} ...`);

      try {
        const [totalAssets, totalSupply] = await Promise.all([
          contract.totalAssets({ blockTag: blockNumber }) as Promise<bigint>,
          contract.totalSupply({ blockTag: blockNumber }) as Promise<bigint>,
        ]);

        const sharePrice = totalSupply > 0n ? Number(totalAssets) / Number(totalSupply) : 0;
        rows.push(`${vault.address.toLowerCase()},${hour},${blockNumber},${totalAssets},${totalSupply},${sharePrice}`);

        if (i % 24 === 23) process.stdout.write(' ok\n');
      } catch (err) {
        process.stdout.write(` WARN: ${err}\n`);
      }

      await sleep(50);
    }
    if (timestamps.length % 24 !== 0) process.stdout.write('\n');
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const outPath   = path.join(__dirname, '..', '..', 'data', 'share-prices.csv');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, rows.join('\n'));
  console.log(`\nSaved ${rows.length - 1} rows → ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
