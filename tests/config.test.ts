import { parseConfig } from "../src/config";

describe("parseConfig", () => {
  it("uses safe local defaults and splits the origin allow-list", () => {
    expect(
      parseConfig({
        DB_SERVER: "localhost",
        DB_USER: "readonly",
        DB_PASSWORD: "password",
        DB_NAME: "catalog",
        ALLOWED_ORIGINS: "https://one.example, https://two.example",
      }),
    ).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      database: {
        port: 1433,
        encrypt: true,
        trustServerCertificate: false,
      },
      allowedOrigins: ["https://one.example", "https://two.example"],
    });
  });

  it("fails explicitly when required database settings are missing", () => {
    expect(() => parseConfig({})).toThrow(/DB_SERVER/);
  });
});
