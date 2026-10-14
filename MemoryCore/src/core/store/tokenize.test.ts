import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetJiebaForTest,
  _setJiebaForTest,
  buildFtsQuery,
  sanitizeFtsToken,
  sanitizeFtsWhitelist,
} from "./tokenize.js";

afterEach(() => _resetJiebaForTest());

describe("FTS5 query sanitization retained from main", () => {
  it.each(['alpha"beta', "AND", "OR", "NOT", "NEAR", "term*", "(term)", "content:term", "^term", "-term", "it's"])(
    "quotes %s as a literal phrase",
    (token) => {
      expect(sanitizeFtsToken(token)).toBe(`"${token.replaceAll('"', '""')}"`);
      const db = new DatabaseSync(":memory:");
      try {
        db.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
        db.prepare("INSERT INTO docs(content) VALUES (?)").run(token);
        expect(db.prepare("SELECT count(*) AS n FROM docs WHERE docs MATCH ?").get(sanitizeFtsToken(token))?.n).toBe(1);
      } finally {
        db.close();
      }
    },
  );

  it("preserves embedded-quote recall through the actual query builder", () => {
    _setJiebaForTest({ cutForSearch: (raw) => [raw] });
    expect(buildFtsQuery('alpha"beta')).toBe('"alpha""beta"');
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
      db.prepare("INSERT INTO docs(content) VALUES (?)").run('alpha"beta');
      expect(db.prepare("SELECT count(*) AS n FROM docs WHERE docs MATCH ?").get(buildFtsQuery('alpha"beta')!)?.n).toBe(1);
      expect(db.prepare("SELECT count(*) AS n FROM docs WHERE docs MATCH ?").get('"alphabeta"')?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("keeps injected boolean syntax inside a literal", () => {
    _setJiebaForTest({ cutForSearch: (raw) => [raw] });
    const query = buildFtsQuery('needle" OR secret OR "needle');
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
      db.prepare("INSERT INTO docs(content) VALUES (?)").run("secret");
      expect(db.prepare("SELECT count(*) AS n FROM docs WHERE docs MATCH ?").get(query!)?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("retains fallback query behavior", () => {
    _setJiebaForTest(null);
    expect(buildFtsQuery("alpha OR beta")).toBe('"alpha" OR "OR" OR "beta"');
    expect(buildFtsQuery("*():^\" ")).toBeNull();
  });

  it.each([
    ["", ""],
    [' hello" * (world):^ ', "hello world"],
    ["中文_123 path/to-file.md", "中文_123 path/to-file.md"],
    ["AND OR NOT NEAR", "AND OR NOT NEAR"],
    ["a\n\t b", "a b"],
  ])("filters raw input %j without dropping useful letters", (raw, expected) => {
    expect(sanitizeFtsWhitelist(raw)).toBe(expected);
  });
});
