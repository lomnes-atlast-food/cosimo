import { describe, expect, test } from "bun:test";
import { type ChainEntry, entryHash, ledgerGenesis, verifyChain } from "./chain.ts";

const ORG = "01J0000000000000000000ORG1";

function mkEntry(seq: number, amount: number): ChainEntry {
  return {
    id: `E${seq}`,
    chainSeq: seq,
    date: "2026-01-15",
    memo: `entry ${seq}`,
    sourceType: "manual",
    sourceId: null,
    reversesEntryId: null,
    createdBy: "U1",
    createdByActor: "user",
    postedAt: "2026-01-15T10:00:00.000Z",
    postedBy: "U1",
    lockOverrideNote: null,
    lines: [
      {
        id: `L${seq}a`,
        accountId: "A1",
        amount,
        currency: "USD",
        description: null,
        contactId: null,
        lineOrder: 0,
      },
      {
        id: `L${seq}b`,
        accountId: "A2",
        amount: -amount,
        currency: "USD",
        description: null,
        contactId: null,
        lineOrder: 1,
      },
    ],
  };
}

function build(n: number) {
  const rows: (ChainEntry & { seq: number; prevHash: string; hash: string })[] = [];
  let prev = ledgerGenesis(ORG);
  for (let i = 1; i <= n; i++) {
    const e = mkEntry(i, i * 100);
    const hash = entryHash(ORG, prev, e);
    rows.push({ ...e, seq: i, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

const compute = (prev: string, r: ChainEntry) => entryHash(ORG, prev, r);

describe("ledger chain", () => {
  test("valid chain verifies", () => {
    const rows = build(5);
    const res = verifyChain("ledger", rows, compute, ledgerGenesis(ORG));
    expect(res.ok).toBe(true);
    expect(res.checked).toBe(5);
    expect(res.headHash).toBe(rows[4]!.hash);
  });
  test("altered amount detected at that link", () => {
    const rows = build(5);
    rows[2]!.lines[0]!.amount += 1;
    const res = verifyChain("ledger", rows, compute, ledgerGenesis(ORG));
    expect(res.ok).toBe(false);
    expect(res.firstBreak?.seq).toBe(3);
  });
  test("deleted link detected", () => {
    const rows = build(5);
    rows.splice(1, 1);
    const res = verifyChain("ledger", rows, compute, ledgerGenesis(ORG));
    expect(res.firstBreak?.seq).toBe(3);
    expect(res.firstBreak?.reason).toContain("gap");
  });
  test("line order independence of input array", () => {
    const e = mkEntry(1, 5);
    const g = ledgerGenesis(ORG);
    const h1 = entryHash(ORG, g, e);
    const h2 = entryHash(ORG, g, { ...e, lines: [...e.lines].reverse() });
    expect(h1).toBe(h2);
  });
});
