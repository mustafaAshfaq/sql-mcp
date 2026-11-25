import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import sql from "mssql";
import { createApplication } from "../src/server";
import type { AppConfig } from "../src/config";

describe("MCP HTTP application", () => {
  let httpServer: Server;
  let closeApplication: () => Promise<void>;
  let databaseQuery: jest.Mock;
  let databaseInput: jest.Mock;

  const config: AppConfig = {
    database: {
      server: "localhost",
      port: 1433,
      user: "readonly",
      password: "password",
      database: "catalog",
      encrypt: true,
      trustServerCertificate: false,
    },
    host: "127.0.0.1",
    port: 3000,
    allowedOrigins: ["https://allowed.example"],
    sessionIdleTimeoutMs: 30000,
  };

  beforeEach(async () => {
    databaseQuery = jest.fn().mockImplementation(async () => ({
      recordset: [{ id: 7 }],
    }));
    const request = {
      input: jest.fn().mockImplementation(() => request),
      query: databaseQuery,
    };
    databaseInput = request.input;
    const pool = {
      request: jest.fn().mockReturnValue(request),
    } as unknown as sql.ConnectionPool;
    const { app, close } = createApplication(config, pool);
    closeApplication = close;
    httpServer = await new Promise<Server>((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server));
    });
  });

  afterEach(async () => {
    await closeApplication();
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("enforces allowed origins and reports database health", async () => {
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const denied = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://untrusted.example" },
    });
    expect(denied.status).toBe(403);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      status: "ok",
      activeSessions: 0,
      database: "connected",
    });
  });

  it.each(["POST", "GET", "DELETE"])(
    "returns the same error for an unknown session on %s",
    async (method) => {
      const address = httpServer.address();
      if (!address || typeof address === "string") throw new Error("Missing address");
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method,
        headers: { "mcp-session-id": "unknown" },
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      });
    },
  );

  it("serves the four tools over a stateful Streamable HTTP session", async () => {
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Missing address");

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "check_table_exists",
        "check_stored_procedure_exists",
        "find_tables_in_stored_procedure",
        "execute_select_query",
      ]);

      const result = await client.callTool({
        name: "execute_select_query",
        arguments: { query: "SELECT id FROM items", limit: 10, offset: 5 },
      });
      expect(result.isError).not.toBe(true);
      expect(databaseInput.mock.calls.map(([name, , value]) => [name, value])).toEqual([
        ["offset", 5],
        ["limit", 10],
      ]);
      expect(databaseQuery).toHaveBeenCalledWith(
        "SELECT id FROM items\nORDER BY (SELECT NULL)\nOFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY",
      );

      const topResult = await client.callTool({
        name: "execute_select_query",
        arguments: {
          query: "SELECT TOP 5 name FROM items ORDER BY name",
          limit: 10,
          offset: 2,
        },
      });
      expect(topResult.isError).not.toBe(true);
      expect(databaseInput.mock.calls.slice(2).map(([name, , value]) => [name, value])).toEqual([
        ["offset", 2],
        ["limit", 3],
      ]);

      const beyondTop = await client.callTool({
        name: "execute_select_query",
        arguments: {
          query: "SELECT TOP (5) name FROM items",
          limit: 10,
          offset: 5,
        },
      });
      expect(beyondTop.isError).not.toBe(true);
      expect(databaseQuery).toHaveBeenCalledTimes(2);

      const rejected = await client.callTool({
        name: "execute_select_query",
        arguments: { query: "DELETE FROM items", limit: 10, offset: 0 },
      });
      expect(rejected.isError).toBe(true);
      expect(databaseQuery).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
    }
  });
});
