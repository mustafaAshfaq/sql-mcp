import sql from "mssql";
import type { AppConfig } from "./config";

export function createDatabasePool(config: AppConfig): sql.ConnectionPool {
  return new sql.ConnectionPool({
    server: config.database.server,
    port: config.database.port,
    database: config.database.database,
    user: config.database.user,
    password: config.database.password,
    options: {
      encrypt: config.database.encrypt,
      trustServerCertificate: config.database.trustServerCertificate,
    },
    pool: {
      min: 0,
      max: 10,
      idleTimeoutMillis: 30000,
    },
    connectionTimeout: 15000,
    requestTimeout: 30000,
  });
}
