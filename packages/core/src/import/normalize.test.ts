import { describe, expect, test } from "bun:test";
import { applyProfile } from "./csv.ts";
import { dedupeHashes, normalizeDescription, payeeKey } from "./normalize.ts";
import { parseOfx } from "./ofx.ts";

describe("normalizeDescription", () => {
  test("strips noise deterministically", () => {
    expect(normalizeDescription("POS PURCHASE  Starbucks #12345 Seattle")).toBe("STARBUCKS SEATTLE");
    expect(normalizeDescription("PURCHASE AUTHORIZED ON 01/29 SHELL OIL 57444 CARD 1234")).toBe(
      "SHELL OIL CARD",
    );
    expect(normalizeDescription("CHECKCARD 0129 AMAZON.COM XXXX1234")).toBe("AMAZON COM");
    expect(normalizeDescription("ACH DEBIT Comcast-Cable 01-15")).toBe("COMCAST CABLE");
    expect(normalizeDescription("DEBIT CARD PURCHASE   netflix.com")).toBe("NETFLIX COM");
    expect(normalizeDescription("Café  Olé")).toBe("CAFE OLE");
    expect(normalizeDescription("a")).toBe(normalizeDescription("  A  "));
  });

  test("payeeKey", () => {
    expect(payeeKey("POS PURCHASE The Home Depot #4412 Atlanta GA")).toBe("HOME DEPOT ATLANTA");
    expect(payeeKey("AMAZON.COM*AB12CD AMZN.COM/BILLWA")).toBe("AMAZON COM AB12CD");
  });
});

describe("dedupeHashes", () => {
  const rows = [
    { date: "2026-01-05", amount: -500, description: "COFFEE SHOP #123" },
    { date: "2026-01-05", amount: -500, description: "Coffee Shop #456" },
    { date: "2026-01-05", amount: -500, description: "COFFEE SHOP" },
    { date: "2026-01-06", amount: -500, description: "COFFEE SHOP" },
  ];

  test("identical same-day rows get different hashes", () => {
    const h = dedupeHashes("acct-1", rows);
    expect(h).toHaveLength(4);
    expect(new Set(h).size).toBe(4);
    for (const x of h) expect(x).toMatch(/^[0-9a-f]{64}$/);
  });

  test("stable across re-parse; account-specific", () => {
    expect(dedupeHashes("acct-1", rows)).toEqual(
      dedupeHashes(
        "acct-1",
        rows.map((r) => ({ ...r })),
      ),
    );
    const a = dedupeHashes("acct-1", rows);
    const b = dedupeHashes("acct-2", rows);
    for (let i = 0; i < a.length; i++) expect(a[i]).not.toBe(b[i]);
  });

  test("occurrence index is per (date, amount, normalized description)", () => {
    const [first] = dedupeHashes("acct-1", [rows[3]!]);
    const all = dedupeHashes("acct-1", rows);
    expect(all[3]).toBe(first);
  });

  test("re-parsing the same CSV and OFX gives identical hashes", () => {
    const csv = "Date,Description,Amount\n2026-01-05,Coffee,-5.00\n2026-01-05,Coffee,-5.00\n";
    const p = {
      hasHeader: true,
      skipRows: 0,
      dateFormat: "YYYY-MM-DD" as const,
      amountMode: "signed" as const,
      signConvention: "positive_is_deposit" as const,
      columns: { date: 0, description: 1, amount: 2 },
    };
    const h1 = dedupeHashes("acct-1", applyProfile(csv, p).rows);
    const h2 = dedupeHashes("acct-1", applyProfile(csv, p).rows);
    expect(h1).toEqual(h2);
    expect(h1[0]).not.toBe(h1[1]);

    const ofx = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><DTPOSTED>20260105<TRNAMT>-5.00<FITID>1<NAME>Coffee</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    expect(dedupeHashes("acct-1", parseOfx(ofx).rows)).toEqual(dedupeHashes("acct-1", parseOfx(ofx).rows));
    expect(dedupeHashes("acct-1", parseOfx(ofx).rows)[0]).toBe(h1[0]);
  });
});
