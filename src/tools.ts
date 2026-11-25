import sql from "mssql";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildPagedQuery } from "./sql/query-guard";

const objectName = z.string().trim().min(1).max(128);

export function registerSqlTools(
  server: McpServer,
  pool: sql.ConnectionPool,
): void {
  server.registerTool(
    "check_table_exists",
    {
      title: "Check table exists",
      description: "Check whether a table exists in the specified schema.",
      inputSchema: { schema: objectName, table: objectName },
    },
    async ({ schema, table }) => {
      const result = await pool
        .request()
        .input("schema", sql.NVarChar(128), schema)
        .input("table", sql.NVarChar(128), table)
        .query<{ exists: boolean }>(
          "SELECT CAST(CASE WHEN EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table AND TABLE_TYPE = 'BASE TABLE') THEN 1 ELSE 0 END AS bit) AS [exists]",
        );
      return textResult({ exists: result.recordset[0]?.exists ?? false });
    },
  );

  server.registerTool(
    "check_stored_procedure_exists",
    {
      title: "Check stored procedure exists",
      description:
        "Check whether a stored procedure exists in the specified schema.",
      inputSchema: { schema: objectName, procedure: objectName },
    },
    async ({ schema, procedure }) => {
      const result = await pool
        .request()
        .input("schema", sql.NVarChar(128), schema)
        .input("procedure", sql.NVarChar(128), procedure)
        .query<{ exists: boolean }>(
          "SELECT CAST(CASE WHEN EXISTS (SELECT 1 FROM sys.procedures AS p INNER JOIN sys.schemas AS s ON s.schema_id = p.schema_id WHERE s.name = @schema AND p.name = @procedure) THEN 1 ELSE 0 END AS bit) AS [exists]",
        );
      return textResult({ exists: result.recordset[0]?.exists ?? false });
    },
  );

  server.registerTool(
    "find_tables_in_stored_procedure",
    {
      title: "Find tables in stored procedure",
      description:
        "List statically referenced tables in a stored procedure. Dynamic SQL references cannot be discovered.",
      inputSchema: { schema: objectName, procedure: objectName },
    },
    async ({ schema, procedure }) => {
      const result = await pool
        .request()
        .input("schema", sql.NVarChar(128), schema)
        .input("procedure", sql.NVarChar(128), procedure)
        .query<{ schemaName: string; tableName: string }>(
          "SELECT DISTINCT referenced_schema.name AS schemaName, referenced_table.name AS tableName FROM sys.procedures AS p INNER JOIN sys.schemas AS procedure_schema ON procedure_schema.schema_id = p.schema_id INNER JOIN sys.sql_expression_dependencies AS dependency ON dependency.referencing_id = p.object_id INNER JOIN sys.tables AS referenced_table ON referenced_table.object_id = dependency.referenced_id INNER JOIN sys.schemas AS referenced_schema ON referenced_schema.schema_id = referenced_table.schema_id WHERE procedure_schema.name = @schema AND p.name = @procedure ORDER BY referenced_schema.name, referenced_table.name",
        );
      return textResult({ tables: result.recordset });
    },
  );

  server.registerTool(
    "execute_select_query",
    {
      title: "Execute SELECT query",
      description:
        "Run a read-only SELECT or WITH query. Limit (1-500) and offset are required.",
      inputSchema: {
        query: z.string().min(1).max(10000),
        limit: z.number().int().min(1).max(500),
        offset: z.number().int().min(0).max(2147483647),
      },
    },
    async ({ query, limit, offset }) => {
      const page = buildPagedQuery(query, limit, offset);
      if (page.limit === 0) return textResult({ rows: [], rowCount: 0 });

      const result = await pool
        .request()
        .input("offset", sql.Int, page.offset)
        .input("limit", sql.Int, page.limit)
        .query(page.query);
      return textResult({
        rows: result.recordset,
        rowCount: result.recordset.length,
      });
    },
  );
}

function textResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
