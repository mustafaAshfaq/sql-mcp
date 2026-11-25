import { z } from "zod";

const booleanFromEnvironment = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const environmentSchema = z.object({
  DB_SERVER: z.string().trim().min(1),
  DB_USER: z.string().trim().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().trim().min(1),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(1433),
  DB_ENCRYPT: booleanFromEnvironment.default(true),
  DB_TRUST_SERVER_CERTIFICATE: booleanFromEnvironment.default(false),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  ALLOWED_ORIGINS: z.string().default(""),
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(300000),
});

export interface AppConfig {
  database: {
    server: string;
    port: number;
    user: string;
    password: string;
    database: string;
    encrypt: boolean;
    trustServerCertificate: boolean;
  };
  host: string;
  port: number;
  allowedOrigins: string[];
  sessionIdleTimeoutMs: number;
}

export function parseConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }

  const values = result.data;
  return {
    database: {
      server: values.DB_SERVER,
      port: values.DB_PORT,
      user: values.DB_USER,
      password: values.DB_PASSWORD,
      database: values.DB_NAME,
      encrypt: values.DB_ENCRYPT,
      trustServerCertificate: values.DB_TRUST_SERVER_CERTIFICATE,
    },
    host: values.HOST,
    port: values.PORT,
    allowedOrigins: values.ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    sessionIdleTimeoutMs: values.SESSION_IDLE_TIMEOUT_MS,
  };
}
