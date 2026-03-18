import fs from 'fs/promises';
import path from 'path';

interface QueryMetadata {
  id: number;
  name: string;
  file: string;
  description: string;
}

const queries: QueryMetadata[] = [
  {
    id: 6852356,
    name: 'IB Vaults Rewards',
    file: 'ib-vaults-rewards.sql',
    description: 'Time-weighted USDS reward per depositor for the Morpho USDS Flagship vault (2026-03-10 to 2026-03-17). Reproduces calculate_rewards.py output.'
  },
  {
    id: 6852397,
    name: 'IB Vaults Raw',
    file: 'ib-vaults-raw.sql',
    description: 'Raw ERC20 Transfer events (full history) for all 5 vaults: stUSDS/USDS Pool, Morpho Risk Capital, Morpho Flagship, Spark USDS Vault, AAVE USDS.'
  },
  {
    id: 6852700,
    name: 'IB Vaults Share Price',
    file: 'ib-vaults-share-price.sql',
    description: 'Hourly share price timeseries (totalAssets / totalSupply). Data uploaded via fetch-share-prices + upload-to-dune scripts.'
  },
  {
    id: 6853959,
    name: 'IB Vaults SSR History',
    file: 'ib-vaults-ssr.sql',
    description: 'Historical SSR (Sky Savings Rate) in bps from the SPBEAM Set events. Referenced by ib-vaults-rewards.sql to look up the APR at period start.'
  }
];

async function loadQuery(queryFile: string): Promise<string> {
  const queriesDir = path.join(process.cwd(), 'queries');
  const filePath = path.join(queriesDir, queryFile);
  return await fs.readFile(filePath, 'utf-8');
}

async function main() {
  console.log('📁 Dune SQL Query Manager\n');
  console.log('Available queries:');
  
  for (const query of queries) {
    console.log(`  • ${query.name} (ID: ${query.id})`);
    console.log(`    File: queries/${query.file}`);
    console.log(`    ${query.description}\n`);
  }

  console.log('💡 To work with these queries:');
  console.log('  1. Edit SQL files in the queries/ folder');
  console.log('  2. Ask me to execute a query by ID or name');
  console.log('  3. Ask me to create new queries or update existing ones');
  console.log('  4. I can execute queries and show you the results\n');

  const exampleQuery = queries[0];
  const sql = await loadQuery(exampleQuery.file);
  console.log(`📄 Example - ${exampleQuery.name}:`);
  console.log(sql);
}

main().catch(console.error);
