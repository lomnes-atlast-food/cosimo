export type ImportFormat = "csv" | "ofx" | "qfx";

/** Detect an import file's format from its extension, falling back to content sniffing. */
export function detectFormat(filename: string, text: string): ImportFormat {
  const ext = /\.([a-z0-9]+)$/i.exec(filename.trim())?.[1]?.toLowerCase();
  if (ext === "qfx") return "qfx";
  if (ext === "ofx") return "ofx";
  const head = text.slice(0, 4096).replace(/^﻿/, "").trimStart();
  const looksOfx = /^OFXHEADER\s*:/i.test(head) || /<\?OFX\b/i.test(head) || /<OFX>/i.test(head);
  if (looksOfx) return /<INTU\./i.test(text) ? "qfx" : "ofx";
  return "csv";
}
