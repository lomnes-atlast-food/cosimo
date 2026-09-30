# Anchor test fixtures

Real proofs used by `src/anchor.test.ts`. Don't regenerate them casually: the tests pin their bytes.

| File | Source |
| --- | --- |
| `hello-world.txt`, `hello-world.txt.ots` | opentimestamps-client `examples/` (https://raw.githubusercontent.com/opentimestamps/opentimestamps-client/master/examples/). A complete proof: Bitcoin block 358391, merkle root `8a1b66ec…5e47e00` as blockstream.info prints it. |
| `incomplete.txt`, `incomplete.txt.ots` | opentimestamps-client `examples/`. A proof pending at alice.btc.calendar.opentimestamps.org. |
| `incomplete.upgrade.bin` | The response to `GET https://alice.btc.calendar.opentimestamps.org/timestamp/<commitment>` for that pending attestation, fetched 2026-09-30. Merged in, it completes the proof at block 428648 (merkle root `078cdde9…3fe18da`, checked against blockstream.info and `ots info`). |
| `anchor-1.txt` | The anchor preimage for the chain-format test vectors (`chain.vectors.test.ts`): org `01JABCDEFGHJKMNPQRSTVWXYZ0`, ledger and audit seq 1. SHA-256 `86af26fe…86e93ed1`. |
| `anchor-1.tsq` | `tsaRequest(digest, 0x1122334455667788n)` for that digest. |
| `anchor-1.freetsa.tsr` | FreeTSA's response to `anchor-1.tsq` from `POST https://freetsa.org/tsr`, 2026-09-30 12:08:38 UTC. ECDSA P-384 with SHA-512. `openssl ts -verify -data anchor-1.txt -in anchor-1.freetsa.tsr -CAfile cacert.pem -untrusted tsa.crt` prints `Verification: OK` with FreeTSA's `cacert.pem` and `tsa.crt`. |
| `anchor-1.alice.pending.ots` | `otsNew` for that digest with nonce `00112233…eeff`, from alice.btc.calendar.opentimestamps.org's `POST /digest` response, 2026-09-30. Pending; `ots info` reads it. |

## `test-tsa/`

A throwaway timestamp authority for the server's mocked tests (`apps/server/test/anchor-mocks.ts`), made with
openssl 3.0 on 2026-09-30: `ca.pem` is a self-signed P-256 root ("Test TSA Root", its key discarded), `tsa.pem` a
P-256 certificate it issued with `extendedKeyUsage=critical,timeStamping`, and `tsa.key` that certificate's key.
Both certificates are valid from 2026-09-30 12:10 UTC for 100 years. Nothing outside tests trusts them.
