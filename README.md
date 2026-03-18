# Dune SQL Query Workspace

TypeScript workspace for managing and executing Dune Analytics SQL queries.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Run the query manager:
```bash
npm run dev
```

## Project Structure

```
├── queries/           # SQL query files
│   └── ib-vaults.sql  # Example query
├── src/
│   ├── index.ts       # Main entry point
│   └── dune-client.ts # Dune API client
└── .cursor/
    └── mcp.json       # Dune MCP configuration
```

## Managing Queries

### Store Queries Locally

Create SQL files in the `queries/` folder:

```sql
-- queries/my-query.sql
SELECT * FROM ethereum.transactions
WHERE block_number > 18000000
LIMIT 100;
```

### Work with Queries via Cursor AI

The Dune MCP is connected and available through Cursor chat. You can:

- **Execute queries**: "Execute the IB Vaults query (ID: 6852356)"
- **Create queries**: "Create a new query called 'Token Transfers'"
- **Update queries**: "Update query 6852356 with new SQL"
- **Search tables**: "Find all Uniswap V3 tables on Ethereum"
- **Get results**: "Get the results for execution ID xyz"

## Dune MCP Configuration

The workspace is connected to Dune MCP in `.cursor/mcp.json`:

**Important**: After editing `mcp.json`:
1. Restart Cursor completely
2. Go to Cursor Settings > Features > Model Context Protocol
3. Enable the Dune server

## Example Queries

### IB Vaults (ID: 6852356)
Test query that retrieves 10 addresses from Ethereum transactions.

File: `queries/ib-vaults.sql`

## Available MCP Tools

- `createDuneQuery` - Create a new query
- `getDuneQuery` - Fetch query details
- `updateDuneQuery` - Update existing query
- `executeQueryById` - Run a query
- `getExecutionResults` - Get query results
- `searchTables` - Find blockchain tables
- `getUsage` - Check API credit usage
