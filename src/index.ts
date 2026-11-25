import "dotenv/config";
import type { Server } from "node:http";
import express from "express";
import { parseConfig } from "./config";
import { createDatabasePool } from "./database";
import { createApplication } from "./server";

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const pool = createDatabasePool(config);
  let closeApplication: (() => Promise<void>) | undefined;

  try {
    await pool.connect();

    const { app, close } = createApplication(config, pool);
    closeApplication = close;
    const httpServer = await listen(app, config.host, config.port);
    console.log(`SQL MCP server listening at http://${config.host}:${config.port}`);

    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      await close();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
      await pool.close();
    };

    const handleShutdown = (): void => {
      void shutdown().catch((error: unknown) => {
        console.error("Failed to shut down SQL MCP server:", error);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", handleShutdown);
    process.once("SIGTERM", handleShutdown);
  } catch (error) {
    if (closeApplication) await closeApplication();
    await pool.close();
    throw error;
  }
}

function listen(
  app: express.Express,
  host: string,
  port: number,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once("error", reject);
  });
}

void main().catch((error: unknown) => {
  console.error("Failed to start SQL MCP server:", error);
  process.exitCode = 1;
});
