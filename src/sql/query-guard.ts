const DENIED_KEYWORDS = new Set([
  "ALTER",
  "BACKUP",
  "BULK",
  "COMMIT",
  "CREATE",
  "DBCC",
  "DELETE",
  "DENY",
  "DROP",
  "EXEC",
  "EXECUTE",
  "GRANT",
  "INSERT",
  "INTO",
  "KILL",
  "MERGE",
  "NEXT",
  "OPENQUERY",
  "OPENROWSET",
  "OPENDATASOURCE",
  "RESTORE",
  "REVOKE",
  "ROLLBACK",
  "SET",
  "SHUTDOWN",
  "TRUNCATE",
  "UPDATE",
  "USE",
  "WAITFOR",
]);

interface Token {
  value: string;
  depth: number;
  start: number;
  end: number;
  number?: boolean;
}

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let depth = 0;

  for (let index = 0; index < query.length; ) {
    const character = query[index]!;
    const next = query[index + 1];

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (character === "-" && next === "-") {
      index += 2;
      while (index < query.length && query[index] !== "\n") index += 1;
      continue;
    }

    if (character === "/" && next === "*") {
      index += 2;
      let commentDepth = 1;
      while (index < query.length && commentDepth > 0) {
        if (query[index] === "/" && query[index + 1] === "*") {
          commentDepth += 1;
          index += 2;
        } else if (query[index] === "*" && query[index + 1] === "/") {
          commentDepth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (commentDepth > 0) throw new Error("Unterminated SQL comment");
      continue;
    }

    if (character === "'" || character === '"' || character === "[") {
      const closingCharacter = character === "[" ? "]" : character;
      index += 1;
      let closed = false;
      while (index < query.length) {
        if (query[index] === closingCharacter) {
          if (query[index + 1] === closingCharacter) {
            index += 2;
          } else {
            index += 1;
            closed = true;
            break;
          }
        } else {
          index += 1;
        }
      }
      if (!closed) throw new Error("Unterminated SQL string or quoted identifier");
      continue;
    }

    if (character === ";") {
      throw new Error("Semicolons are not allowed in read-only queries");
    }

    if (character === ")") {
      depth -= 1;
      if (depth < 0) throw new Error("Unbalanced SQL parentheses");
      index += 1;
      continue;
    }

    if (character === "(") {
      depth += 1;
      index += 1;
      continue;
    }

    if (/[A-Za-z_@#]/.test(character)) {
      const start = index;
      index += 1;
      while (index < query.length && /[A-Za-z0-9_@$#]/.test(query[index]!)) {
        index += 1;
      }
      tokens.push({
        value: query.slice(start, index).toUpperCase(),
        depth,
        start,
        end: index,
      });
      continue;
    }

    if (/[0-9]/.test(character)) {
      const start = index;
      index += 1;
      while (index < query.length && /[0-9]/.test(query[index]!)) index += 1;
      tokens.push({
        value: query.slice(start, index),
        depth,
        start,
        end: index,
        number: true,
      });
      continue;
    }

    index += 1;
  }

  if (depth !== 0) throw new Error("Unbalanced SQL parentheses");
  return tokens;
}

export function validateReadOnlyQuery(query: string): string {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("Query must not be empty");
  }

  const tokens = tokenize(query);
  const firstKeyword = tokens[0]?.value;
  if (firstKeyword !== "SELECT" && firstKeyword !== "WITH") {
    throw new Error("Only SELECT and WITH queries are allowed");
  }

  const deniedKeyword = tokens.find((token) =>
    DENIED_KEYWORDS.has(token.value),
  );
  if (deniedKeyword) {
    throw new Error(`The ${deniedKeyword.value} keyword is not allowed`);
  }

  return query.trim();
}

interface PagedQuery {
  query: string;
  limit: number;
  offset: number;
}

function skipTrivia(query: string, start: number): number {
  let index = start;
  while (index < query.length) {
    if (/\s/.test(query[index]!)) {
      index += 1;
    } else if (query[index] === "-" && query[index + 1] === "-") {
      index += 2;
      while (index < query.length && query[index] !== "\n") index += 1;
    } else if (query[index] === "/" && query[index + 1] === "*") {
      index += 2;
      let depth = 1;
      while (index < query.length && depth > 0) {
        if (query[index] === "/" && query[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (query[index] === "*" && query[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
    } else {
      break;
    }
  }
  return index;
}

function readWord(query: string, start: number): { word: string; end: number } {
  const index = skipTrivia(query, start);
  const match = /^[A-Za-z_]+/.exec(query.slice(index));
  return match
    ? { word: match[0].toUpperCase(), end: index + match[0].length }
    : { word: "", end: index };
}

function removeTopClause(
  query: string,
  tokens: Token[],
): { query: string; limit?: number } {
  if (tokens[0]?.value !== "SELECT") return { query };
  let tokenIndex = 1;
  if (tokens[tokenIndex]?.value === "ALL" || tokens[tokenIndex]?.value === "DISTINCT") {
    tokenIndex += 1;
  }

  const topToken = tokens[tokenIndex];
  if (topToken?.value !== "TOP") return { query };

  let index = skipTrivia(query, topToken.end);
  const parenthesized = query[index] === "(";
  if (parenthesized) index = skipTrivia(query, index + 1);

  const numberStart = index;
  while (index < query.length && /[0-9]/.test(query[index]!)) index += 1;
  if (numberStart === index) {
    if (parenthesized) {
      throw new Error("TOP expressions must be integer literals");
    }
    return { query };
  }

  const topLimit = Number(query.slice(numberStart, index));
  if (!Number.isSafeInteger(topLimit)) {
    throw new Error("TOP value must be a safe integer");
  }

  index = skipTrivia(query, index);
  if (parenthesized) {
    if (query[index] !== ")") {
      throw new Error("TOP expressions must be integer literals");
    }
    index = skipTrivia(query, index + 1);
  }

  const modifier = readWord(query, index);
  if (modifier.word === "PERCENT") {
    throw new Error("TOP PERCENT cannot be combined with limit and offset");
  }
  if (modifier.word === "WITH") {
    const ties = readWord(query, modifier.end);
    if (ties.word === "TIES") {
      throw new Error("TOP WITH TIES cannot be combined with limit and offset");
    }
  }

  return {
    query: `${query.slice(0, topToken.start)}${query.slice(index)}`,
    limit: topLimit,
  };
}

export function buildPagedQuery(
  query: string,
  limit: number,
  offset: number,
): PagedQuery {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Limit must be an integer between 1 and 500");
  }
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 2147483647
  ) {
    throw new Error("Offset must be a non-negative SQL Server integer");
  }

  const validatedQuery = validateReadOnlyQuery(query);
  const originalTokens = tokenize(validatedQuery);
  const topClause = removeTopClause(validatedQuery, originalTokens);
  const validatedWithoutTop = validateReadOnlyQuery(topClause.query);
  const effectiveLimit =
    topClause.limit === undefined
      ? limit
      : Math.min(limit, Math.max(topClause.limit - offset, 0));
  const tokens = tokenize(validatedWithoutTop);
  const topLevelTokens = tokens.filter((token) => token.depth === 0);
  const orderByIndex = topLevelTokens.findIndex(
    (token, index) =>
      token.value === "ORDER" && topLevelTokens[index + 1]?.value === "BY",
  );

  if (orderByIndex !== -1) {
    const existingPagination = topLevelTokens
      .slice(orderByIndex + 2)
      .some((token) => token.value === "OFFSET" || token.value === "FETCH");
    if (existingPagination) {
      throw new Error("Query pagination is managed by limit and offset");
    }
  }

  const orderBy = orderByIndex === -1 ? "ORDER BY (SELECT NULL)\n" : "";
  return {
    query: `${validatedWithoutTop}\n${orderBy}OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    limit: effectiveLimit,
    offset,
  };
}
