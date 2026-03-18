/**
 * Uploads data/share-prices.csv to a Dune user table.
 *
 * Usage:
 *   npm run upload-to-dune
 *
 * Requires .env:
 *   DUNE_API_KEY   — Dune API key
 *   DUNE_USERNAME  — Your Dune username (find at dune.com/settings/profile)
 */

import { config } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

config();

const TABLE_NAME = 'ib_vaults_share_prices';

const SCHEMA = [
  { name: 'vault_address', type: 'varchar' },
  { name: 'hour',          type: 'timestamp' },
  { name: 'block_number',  type: 'bigint' },
  { name: 'total_assets',  type: 'varchar' },
  { name: 'total_supply',  type: 'varchar' },
  { name: 'share_price',   type: 'double' },
];

async function createTable(apiKey: string, namespace: string): Promise<void> {
  const resp = await fetch('https://api.dune.com/api/v1/table/create', {
    method: 'POST',
    headers: { 'X-Dune-Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ namespace, table_name: TABLE_NAME, schema: SCHEMA, is_private: false }),
  });
  const body = await resp.json() as { error?: string };
  if (!resp.ok && !body.error?.includes('already exists')) {
    throw new Error(`Create table failed: ${JSON.stringify(body)}`);
  }
  if (body.error?.includes('already exists')) {
    console.log('Table already exists — will insert (appending rows).');
  } else {
    console.log('Table created.');
  }
}

async function clearTable(apiKey: string, namespace: string): Promise<void> {
  const resp = await fetch(
    `https://api.dune.com/api/v1/table/${namespace}/${TABLE_NAME}/clear`,
    { method: 'POST', headers: { 'X-Dune-Api-Key': apiKey } },
  );
  if (!resp.ok) {
    const body = await resp.json();
    throw new Error(`Clear table failed: ${JSON.stringify(body)}`);
  }
  console.log('Table cleared.');
}

async function insertCSV(apiKey: string, namespace: string, csv: string): Promise<void> {
  const resp = await fetch(
    `https://api.dune.com/api/v1/table/${namespace}/${TABLE_NAME}/insert`,
    {
      method: 'POST',
      headers: { 'X-Dune-Api-Key': apiKey, 'Content-Type': 'text/csv' },
      body: csv,
    },
  );
  if (!resp.ok) {
    const body = await resp.json();
    throw new Error(`Insert failed: ${JSON.stringify(body)}`);
  }
  console.log('Data inserted.');
}

async function main() {
  const apiKey    = process.env.DUNE_API_KEY;
  const namespace = process.env.DUNE_USERNAME;
  if (!apiKey)    throw new Error('DUNE_API_KEY not set in .env');
  if (!namespace) throw new Error('DUNE_USERNAME not set in .env — find it at https://dune.com/settings/profile');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const csvPath   = path.join(__dirname, '..', '..', 'data', 'share-prices.csv');
  const csv       = fs.readFileSync(csvPath, 'utf-8');
  const rowCount  = csv.split('\n').length - 1;

  console.log(`Uploading ${rowCount} rows to dune.${namespace}.${TABLE_NAME} ...`);

  await createTable(apiKey, namespace);
  await clearTable(apiKey, namespace);
  await insertCSV(apiKey, namespace, csv);

  console.log(`\nDone. Query it in Dune SQL as:`);
  console.log(`  SELECT * FROM dune.${namespace}.${TABLE_NAME}`);
  console.log(`\nUpdate ib-vaults-share-price.sql — replace {{dune_username}} with: ${namespace}`);
}

main().catch(err => { console.error(err); process.exit(1); });
