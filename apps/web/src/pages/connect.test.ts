import { describe, expect, test } from "bun:test";
import { safeNext } from "./connect.tsx";

const origin = "https://app.example.com";

describe("safeNext", () => {
  test("keeps a same-origin path", () => {
    expect(safeNext("/accounting", origin)).toBe("/accounting");
  });
  test("keeps query and hash", () => {
    expect(safeNext("/connect?client_id=x#y", origin)).toBe("/connect?client_id=x#y");
  });
  test.each(["/.//evil.com", "/..//evil.com", "/%2e//evil.com", "/./\\evil.com"])(
    "never returns a protocol-relative path for %j",
    (v) => {
      const next = safeNext(v, origin);
      expect(next.startsWith("//")).toBe(false);
      expect(new URL(next, origin).origin).toBe(origin);
    },
  );
  test.each([
    "//evil.com",
    "/\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "/\r\n/evil.com",
    "https://evil.com",
    "javascript:alert(1)",
    null,
    "",
  ])("rejects %j", (v) => {
    expect(safeNext(v, origin)).toBe("/");
  });
});
