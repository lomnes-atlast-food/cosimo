import { describe, expect, test } from "bun:test";
import { detectFormat } from "./detect.ts";
import { decodeEntities, parseOfx } from "./ofx.ts";

const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>20260201120000.000[-5:EST]
<LANGUAGE>ENG
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>121000248
<ACCTID>1234567890
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260101120000.000[-5:EST]
<DTEND>20260131120000.000[-5:EST]
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260105120000.000[-5:EST]
<TRNAMT>-42.17
<FITID>202601050001
<NAME>JOE'S CAFE &amp; BAKERY
<MEMO>POS PURCHASE
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260115
<TRNAMT>2500.00
<FITID>202601150002
<NAME>ACME CORP PAYROLL
<MEMO>ACME CORP PAYROLL
</STMTTRN>
<STMTTRN>
<TRNTYPE>CHECK
<DTPOSTED>20260120120000[-5:EST]
<TRNAMT>-150,00
<FITID>202601200003
<CHECKNUM>1042
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260231
<TRNAMT>-1.00
<FITID>bad-date
<NAME>BROKEN
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>3307.83
<DTASOF>20260131120000.000[-5:EST]
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;

const OFX_XML_CC = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <SIGNONMSGSRSV1>
    <SONRS>
      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
      <DTSERVER>20260301083000.000</DTSERVER>
      <LANGUAGE>ENG</LANGUAGE>
    </SONRS>
  </SIGNONMSGSRSV1>
  <CREDITCARDMSGSRSV1>
    <CCSTMTTRNRS>
      <TRNUID>0</TRNUID>
      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
      <CCSTMTRS>
        <CURDEF>USD</CURDEF>
        <CCACCTFROM><ACCTID>4111111111111111</ACCTID></CCACCTFROM>
        <BANKTRANLIST>
          <DTSTART>20260201</DTSTART>
          <DTEND>20260228</DTEND>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE>
            <DTPOSTED>20260203000000.000[0:GMT]</DTPOSTED>
            <TRNAMT>-89.99</TRNAMT>
            <FITID>2026020324692160</FITID>
            <NAME>AMAZON MKTPL*AB12CD34</NAME>
            <MEMO></MEMO>
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>CREDIT</TRNTYPE>
            <DTPOSTED>20260210</DTPOSTED>
            <TRNAMT>500.00</TRNAMT>
            <FITID>2026021000001</FITID>
            <NAME>PAYMENT THANK YOU</NAME>
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE>
            <DTPOSTED>20260214</DTPOSTED>
            <TRNAMT>-12.50</TRNAMT>
            <FITID>2026021400002</FITID>
            <NAME>&quot;LUNCH&quot; &lt;DELI&gt; &#38; CO</NAME>
            <MEMO>Food &amp; drink</MEMO>
          </STMTTRN>
        </BANKTRANLIST>
        <LEDGERBAL><BALAMT>-1234.56</BALAMT><DTASOF>20260228</DTASOF></LEDGERBAL>
      </CCSTMTRS>
    </CCSTMTTRNRS>
  </CREDITCARDMSGSRSV1>
</OFX>
`;

const QFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20260401<LANGUAGE>ENG<FI><ORG>B1<FID>10898</FI><INTU.BID>10898<INTU.USERID>someone</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>CAD<BANKACCTFROM><BANKID>000<ACCTID>9876<ACCTTYPE>SAVINGS</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260301<DTEND>20260331
<STMTTRN><TRNTYPE>INT<DTPOSTED>20260331<TRNAMT>3.21<FITID>INT0331<NAME>INTEREST PAID</STMTTRN>
<STMTTRN><TRNTYPE>XFER<DTPOSTED>20260315<TRNAMT>-1,000.00<FITID>X0315<NAME>TRANSFER TO CHQ<MEMO>Online banking</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>10003.21<DTASOF>20260331</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe("parseOfx", () => {
  test("OFX 1.02 SGML bank statement", () => {
    const r = parseOfx(OFX_SGML);
    expect(r.account).toEqual({
      bankId: "121000248",
      accountId: "1234567890",
      accountType: "CHECKING",
      currency: "USD",
    });
    expect(r.ledgerBalance).toEqual({ amount: 330783, date: "2026-01-31" });
    expect(r.rows).toEqual([
      {
        date: "2026-01-05",
        amount: -4217,
        description: "JOE'S CAFE & BAKERY - POS PURCHASE",
        payee: "JOE'S CAFE & BAKERY",
        providerId: "202601050001",
        row: 1,
      },
      {
        date: "2026-01-15",
        amount: 250000,
        description: "ACME CORP PAYROLL",
        payee: "ACME CORP PAYROLL",
        providerId: "202601150002",
        row: 2,
      },
      {
        date: "2026-01-20",
        amount: -15000,
        description: "CHECK 1042",
        payee: null,
        providerId: "202601200003",
        row: 3,
      },
    ]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.row).toBe(4);
    expect(r.errors[0]?.message).toContain("invalid date");
  });

  test("OFX 2.x XML credit card statement", () => {
    const r = parseOfx(OFX_XML_CC);
    expect(r.errors).toEqual([]);
    expect(r.account).toEqual({
      bankId: null,
      accountId: "4111111111111111",
      accountType: "CREDITCARD",
      currency: "USD",
    });
    expect(r.ledgerBalance).toEqual({ amount: -123456, date: "2026-02-28" });
    expect(r.rows.map((t) => [t.date, t.amount, t.description, t.providerId])).toEqual([
      ["2026-02-03", -8999, "AMAZON MKTPL*AB12CD34", "2026020324692160"],
      ["2026-02-10", 50000, "PAYMENT THANK YOU", "2026021000001"],
      ["2026-02-14", -1250, '"LUNCH" <DELI> & CO - Food & drink', "2026021400002"],
    ]);
  });

  test("QFX with INTU tags", () => {
    expect(detectFormat("export.qfx", QFX)).toBe("qfx");
    expect(detectFormat("download", QFX)).toBe("qfx");
    const r = parseOfx(QFX);
    expect(r.errors).toEqual([]);
    expect(r.account?.currency).toBe("CAD");
    expect(r.account?.accountType).toBe("SAVINGS");
    expect(r.rows.map((t) => [t.date, t.amount, t.description, t.payee])).toEqual([
      ["2026-03-31", 321, "INTEREST PAID", "INTEREST PAID"],
      ["2026-03-15", -100000, "TRANSFER TO CHQ - Online banking", "TRANSFER TO CHQ"],
    ]);
    expect(r.ledgerBalance).toEqual({ amount: 1000321, date: "2026-03-31" });
  });

  test("non-statement OFX reports an error instead of throwing", () => {
    const r = parseOfx("<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>");
    expect(r.rows).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });

  test("decodeEntities", () => {
    expect(decodeEntities("A&amp;B &lt;x&gt; &quot;q&quot; &apos;s&apos; &#65;&#x42; &bogus;")).toBe(
      "A&B <x> \"q\" 's' AB &bogus;",
    );
  });

  // TAG_RE previously backtracked catastrophically on an unclosed tag name followed by a long run
  // of dots (both [A-Za-z0-9_.]* and [^>]*? can match ".").
  test("an unclosed tag name doesn't cause catastrophic backtracking", () => {
    const start = performance.now();
    parseOfx(`<OFX><A${".".repeat(50_000)}`);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe("detectFormat", () => {
  test("by extension and content", () => {
    expect(detectFormat("stmt.OFX", "")).toBe("ofx");
    expect(detectFormat("stmt.qfx", "")).toBe("qfx");
    expect(detectFormat("stmt.csv", "Date,Amount\n")).toBe("csv");
    expect(detectFormat("stmt.txt", OFX_SGML)).toBe("ofx");
    expect(detectFormat("stmt", OFX_XML_CC)).toBe("ofx");
    expect(detectFormat("stmt", "Date,Amount\n01/01/2026,1.00")).toBe("csv");
  });
});
