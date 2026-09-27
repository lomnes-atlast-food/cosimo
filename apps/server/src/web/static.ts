import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import type { Context } from "hono";
import { embeddedAssets } from "./assets.gen.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function diskRoot(): string | null {
  const candidates = [
    process.env.COSIMO_WEB_DIR,
    resolve(import.meta.dir, "../../../web/dist"),
    resolve(process.cwd(), "apps/web/dist"),
  ].filter(Boolean) as string[];
  return candidates.find((d) => existsSync(join(d, "index.html"))) ?? null;
}

let root: string | null | undefined;

async function lookup(path: string): Promise<{ file: Blob; type: string; immutable: boolean } | null> {
  const clean = normalize(path)
    .replace(/^([/\\])+/, "")
    .replace(/\\/g, "/");
  if (clean.includes("..")) return null;
  const type = MIME[extname(clean)] ?? "application/octet-stream";
  const immutable = clean.startsWith("assets/");
  if (embeddedAssets) {
    const p = embeddedAssets[clean];
    return p ? { file: Bun.file(p), type, immutable } : null;
  }
  root ??= diskRoot();
  if (!root) return null;
  const full = join(root, clean);
  if (!full.startsWith(root) || !existsSync(full) || !statSync(full).isFile()) return null;
  return { file: Bun.file(full), type, immutable };
}

export function hasWebAssets(): boolean {
  if (embeddedAssets) return true;
  root ??= diskRoot();
  return Boolean(root);
}

/** Serve built web assets, falling back to index.html for client-side routes. */
export async function serveWeb(c: Context): Promise<Response> {
  const path = c.req.path;
  let hit = path !== "/" ? await lookup(path) : null;
  if (!hit) {
    if (extname(path) && !path.endsWith(".html")) return c.text("Not found", 404);
    hit = await lookup("index.html");
    if (!hit) {
      return c.html(
        "<!doctype html><title>Cosimo</title><p>Cosimo API is running. The web UI has not been built (run <code>bun run build:web</code>).</p>",
      );
    }
  }
  return new Response(hit.file, {
    headers: {
      "content-type": hit.type,
      "cache-control": hit.immutable ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}
