import {
  buildPagedQuery,
  validateReadOnlyQuery,
} from "../src/sql/query-guard";

describe("validateReadOnlyQuery", () => {
  it("accepts SELECT and WITH queries", () => {
    expect(validateReadOnlyQuery("  SELECT name FROM sys.tables  ")).toBe(
      "SELECT name FROM sys.tables",
    );
    expect(validateReadOnlyQuery("WITH items AS (SELECT 1 AS id) SELECT id FROM items")).toContain(
      "WITH",
    );
  });

  it.each([
    "UPDATE users SET active = 0",
    "SELECT 1; DROP TABLE users",
    "SELECT name INTO copied_users FROM users",
    "SELECT * FROM users WHERE id = 1 OR 1 = 1; DELETE FROM users",
    "EXEC sp_configure",
  ])("rejects unsafe statement: %s", (query) => {
    expect(() => validateReadOnlyQuery(query)).toThrow();
  });

  it("does not mistake quoted text or identifiers for denied keywords", () => {
    expect(validateReadOnlyQuery("SELECT 'DELETE' AS label, [UPDATE] FROM users")).toContain(
      "'DELETE'",
    );
  });
});

describe("buildPagedQuery", () => {
  it("appends parameterized paging to a query without ordering", () => {
    expect(buildPagedQuery("SELECT name FROM sys.tables", 10, 5)).toEqual({
      query:
        "SELECT name FROM sys.tables\nORDER BY (SELECT NULL)\nOFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY",
      limit: 10,
      offset: 5,
    });
  });

  it("keeps an existing order and rejects caller-controlled pagination", () => {
    expect(
      buildPagedQuery("SELECT name FROM sys.tables ORDER BY name", 10, 0).query,
    ).toBe(
      "SELECT name FROM sys.tables ORDER BY name\nOFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY",
    );
    expect(() =>
      buildPagedQuery(
        "SELECT name FROM sys.tables ORDER BY name OFFSET 0 ROWS",
        10,
        0,
      ),
    ).toThrow(/pagination/i);
  });

  it("preserves TOP semantics and caps the requested page", () => {
    expect(buildPagedQuery("SELECT TOP 5 name FROM sys.tables", 10, 2)).toEqual({
      query:
        "SELECT name FROM sys.tables\nORDER BY (SELECT NULL)\nOFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY",
      limit: 3,
      offset: 2,
    });
    expect(() =>
      buildPagedQuery("SELECT TOP 5 PERCENT name FROM sys.tables", 10, 0),
    ).toThrow(/TOP PERCENT/i);
  });
});
