/**
 * Fixed test vectors for the chain format. CI runs this on Linux, macOS, and Windows to prove
 * canonical hashing is identical everywhere (SPEC §6.5, §15.1). If these change, the chain
 * format changed: bump CHAIN_FORMAT_VERSION and document it in docs/chain-format.md.
 */
import { expect, test } from "bun:test";
import {
  anchorDigest,
  anchorPreimage,
  auditGenesis,
  auditHash,
  canonicalJson,
  entryHash,
  ledgerGenesis,
  ledgerPayload,
} from "./index.ts";

const ORG = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const ENTRY = {
  id: "01JENTRY00000000000000000A",
  chainSeq: 1,
  date: "2026-03-31",
  memo: 'Café — invoice #7 "paid"\n',
  sourceType: "manual",
  sourceId: null,
  reversesEntryId: null,
  createdBy: "01JUSER000000000000000000A",
  createdByActor: "user",
  postedAt: "2026-03-31T12:00:00.000Z",
  postedBy: "01JUSER000000000000000000A",
  lockOverrideNote: null,
  lines: [
    {
      id: "L2",
      accountId: "A-4000",
      amount: -123456,
      currency: "USD",
      description: "Revenue 😀",
      contactId: null,
      lineOrder: 1,
    },
    {
      id: "L1",
      accountId: "A-1000",
      amount: 123456,
      currency: "USD",
      description: null,
      contactId: "C1",
      lineOrder: 0,
    },
  ],
};
const AUDIT = {
  id: "01JAUDIT00000000000000000A",
  seq: 1,
  at: "2026-03-31T12:00:00.000Z",
  userId: "U",
  apiTokenId: null,
  oauthClientId: null,
  actor: "user",
  action: "entry.post",
  targetType: "journal_entry",
  targetId: "E",
  beforeJson: null,
  afterJson: '{"amount":5}',
  ip: "127.0.0.1",
};

test("genesis hashes", () => {
  expect(ledgerGenesis(ORG)).toBe("172ebd5fafd0842251004b031a2894cd790af47ee40a6dcb66cc26fbdf525a7d");
  expect(auditGenesis(ORG)).toBe("dcc76dfa614c5d05797d4ed932e00b5cffa57df79ebe315fb4db3b8b0f617c39");
});

test("canonical ledger payload", () => {
  expect(canonicalJson(ledgerPayload(ORG, ENTRY))).toBe(
    '{"chain":"ledger","chain_seq":1,"created_by":"01JUSER000000000000000000A","created_by_actor":"user","date":"2026-03-31","id":"01JENTRY00000000000000000A","lines":[{"account_id":"A-1000","amount":123456,"contact_id":"C1","currency":"USD","description":null,"id":"L1","line_order":0},{"account_id":"A-4000","amount":-123456,"contact_id":null,"currency":"USD","description":"Revenue 😀","id":"L2","line_order":1}],"lock_override_note":null,"memo":"Café — invoice #7 \\"paid\\"\\n","org_id":"01JABCDEFGHJKMNPQRSTVWXYZ0","posted_at":"2026-03-31T12:00:00.000Z","posted_by":"01JUSER000000000000000000A","reverses_entry_id":null,"source_id":null,"source_type":"manual","v":1}',
  );
});

test("entry and audit hashes", () => {
  expect(entryHash(ORG, ledgerGenesis(ORG), ENTRY)).toBe(
    "88bd7600acfefeb2df2389f7665ff37bce4fae1a7d9fac43450b70d64b56763d",
  );
  expect(auditHash(ORG, auditGenesis(ORG), AUDIT)).toBe(
    "0287e99de8d4cce788a7953f3fffbcba8de6b54de734e1cdbe8862d0fc5c47a6",
  );
});

test("anchor preimage and digest", () => {
  const ledger = { seq: 1, hash: entryHash(ORG, ledgerGenesis(ORG), ENTRY) };
  const audit = { seq: 1, hash: auditHash(ORG, auditGenesis(ORG), AUDIT) };
  expect(anchorPreimage(ORG, ledger, audit)).toBe(
    "cosimo-anchor v1\norg 01JABCDEFGHJKMNPQRSTVWXYZ0\n" +
      "ledger 1 88bd7600acfefeb2df2389f7665ff37bce4fae1a7d9fac43450b70d64b56763d\n" +
      "audit 1 0287e99de8d4cce788a7953f3fffbcba8de6b54de734e1cdbe8862d0fc5c47a6\n",
  );
  expect(anchorDigest(ORG, ledger, audit)).toBe(
    "86af26feace2fa6114b0ab6beb4e448c253766c69111655de29ed72e86e93ed1",
  );
  // An empty ledger anchors its genesis at seq 0.
  expect(anchorDigest(ORG, { seq: 0, hash: ledgerGenesis(ORG) }, { seq: 0, hash: auditGenesis(ORG) })).toBe(
    "4239d74775956c193b90e99f43017e32a87186941df0a58a8ceee0dece82e5a4",
  );
});
