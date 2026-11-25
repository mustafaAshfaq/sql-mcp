import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import sql from "mssql";
import type { AppConfig } from "./config";
import { registerSqlTools } from "./tools";

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

export function createApplication(
  config: AppConfig,
  pool: sql.ConnectionPool,
): { app: express.Express; close: () => Promise<void> } {
  const app = express();
  const sessions = new Map<string, McpSession>();

  app.use((req, res, next) => {
    const origin = req.get("Origin");
    if (origin && !config.allowedOrigins.includes(origin)) {
      res.status(403).json({ error: "Origin is not allowed" });
      return;
    }
    next();
  });
  app.use(cors({ origin: config.allowedOrigins }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", async (_req, res) => {
    let database: "connected" | "disconnected" = "connected";
    let status = 200;
    try {
      await pool.request().query("SELECT 1 AS [ok]");
    } catch (error) {
      database = "disconnected";
      status = 503;
      console.error("Database health check failed:", error);
    }

    res.status(status).json({
      status: database === "connected" ? "ok" : "degraded",
      uptimeSeconds: Math.floor(process.uptime()),
      activeSessions: sessions.size,
      database,
    });
  });

  app.post("/mcp", async (req, res, next) => {
    try {
      const sessionId = getSessionId(req);
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (sessionId && !session) {
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        });
        return;
      }

      if (!session) {
        if (req.body?.method !== "initialize") {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32600, message: "Initialize an MCP session first" },
            id: req.body?.id ?? null,
          });
          return;
        }
        session = await createSession(pool, sessions);
      }

      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      next(error);
    }
  });

  const handleSessionRequest = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const sessionId = getSessionId(req);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      });
      return;
    }

    session.lastActivity = Date.now();
    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      next(error);
    }
  };
  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Request failed:", error);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  });

  const expiryCheck = setInterval(() => {
    void expireIdleSessions(sessions, config.sessionIdleTimeoutMs).catch(
      (error: unknown) => console.error("MCP session expiry failed:", error),
    );
  }, Math.max(1000, Math.min(config.sessionIdleTimeoutMs, 60000)));
  expiryCheck.unref();

  return {
    app,
    close: async () => {
      clearInterval(expiryCheck);
      await Promise.all(
        [...sessions.values()].map(({ server }) => server.close()),
      );
      sessions.clear();
    },
  };
}

async function createSession(
  pool: sql.ConnectionPool,
  sessions: Map<string, McpSession>,
): Promise<McpSession> {
  const server = new McpServer({ name: "sql-mcp-server", version: "1.0.0" });
  registerSqlTools(server, pool);

  let session: McpSession | undefined;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      if (!session) throw new Error("MCP session was initialized unexpectedly");
      sessions.set(sessionId, session);
    },
    onsessionclosed: (sessionId) => {
      sessions.delete(sessionId);
    },
  });

  session = { server, transport, lastActivity: Date.now() };
  await server.connect(transport);
  return session;
}

function getSessionId(req: Request): string | undefined {
  const sessionId = req.get("mcp-session-id");
  return sessionId || undefined;
}

async function expireIdleSessions(
  sessions: Map<string, McpSession>,
  idleTimeoutMs: number,
): Promise<void> {
  const expirationTime = Date.now() - idleTimeoutMs;
  for (const [sessionId, session] of sessions) {
    if (session.lastActivity <= expirationTime) {
      await session.server.close();
      sessions.delete(sessionId);
    }
  }
}
