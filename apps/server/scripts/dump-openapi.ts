/** Print the OpenAPI document (used to generate the web client types). */
import { defaultConfig, finalize } from "../src/config.ts";
import { generateMasterKey } from "../src/crypto.ts";
import { createApp } from "../src/http/app.ts";
import "../src/modules.ts";
import type { AppContext } from "../src/context.ts";

const cfg = finalize(defaultConfig("/tmp/cosimo-openapi"));
cfg.security.master_key = generateMasterKey();
// The document only needs route metadata, so a stub context is enough.
const { createLogger } = await import("../src/logger.ts");
const app = createApp({
  config: cfg,
  version: (await import("@cosimo/shared")).VERSION,
  logger: createLogger({ stream: (l) => process.stderr.write(`${l}\n`) }),
} as unknown as AppContext);
const res = await app.request("/api/v1/openapi.json");
process.stdout.write(`${JSON.stringify(await res.json(), null, 2)}\n`);
