# SQL MCP Server

A read-only Model Context Protocol server for Microsoft SQL Server. It exposes
schema discovery and bounded `SELECT` queries over Streamable HTTP.

## Setup

1. Install Node.js 18 or newer and run `npm install`.
2. Copy `.env.example` to `.env` and set `DB_SERVER`, `DB_USER`,
   `DB_PASSWORD`, and `DB_NAME`. Use a database login with read-only
   permissions.
3. Configure `ALLOWED_ORIGINS` as a comma-separated list of exact origins
   permitted to call the HTTP service.
4. Run `npm run build` and `npm start` (or `npm run dev` while developing).

The server listens on `http://127.0.0.1:3000` by default. Configure a client
with:

```json
{
  "servers": {
    "sql-mcp-server": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

`GET /health` reports service uptime, active MCP sessions, and database
connectivity. MCP sessions expire after `SESSION_IDLE_TIMEOUT_MS`.

## Tools

- `check_table_exists`: Check a table by schema and name.
- `check_stored_procedure_exists`: Check a procedure by schema and name.
- `find_tables_in_stored_procedure`: List statically referenced tables; dynamic
  SQL dependencies are not discoverable.
- `execute_select_query`: Run a `SELECT` or `WITH` query with required `limit`
  (1-500) and `offset` values.

The query tool rejects statement stacking and denied write/administrative
keywords before dispatch. Pagination values are sent as SQL parameters, and
the database login should still be restricted to read-only access.

## Commands

- `npm test` runs Jest tests.
- `npm run typecheck` checks TypeScript.
- `npm run build` emits `dist/`.
