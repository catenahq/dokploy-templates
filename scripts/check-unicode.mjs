#!/usr/bin/env node
// Unicode hygiene gate (per workspace CLAUDE.md hard rule: no em dashes,
// smart quotes, decorative Unicode). Fails the run if any forbidden
// character appears in a tracked source file. Natural-language
// characters (accented letters, CJK, etc.) are unaffected.
//
// Wired as `npm run check:unicode` and a CI step in ci.yml.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FORBIDDEN = {
  "—": 'em dash (use "--")',
  "–": 'en dash (use "-")',
  "→": 'rightwards arrow (use "->")',
  "←": 'leftwards arrow (use "<-")',
  "…": 'ellipsis (use "...")',
  "“": "left curly double quote (use straight \")",
  "”": "right curly double quote (use straight \")",
  "‘": "left curly single quote (use straight ')",
  "’": "right curly single quote (use straight ')",
  "«": "left guillemet (use straight \")",
  "»": "right guillemet (use straight \")",
};

const SKIP_DIR_PATTERNS = [
  /^vendor\//,
  /^dist\//,
  /^\.next\//,
  /^\.astro\//,
  /^node_modules\//,
  /^\.git\//,
];

const SKIP_FILE_PATTERNS = [
  /package-lock\.json$/,
  /\.tgz$/,
  /\.lock$/,
  /scripts\/check-unicode\.mjs$/,
  // Third-party text we do not control. The CC/Apache/MIT boilerplate
  // ships with curly quotes in upstream form and modifying it would
  // alter the legal text.
  /^LICENSE(\..*)?$/,
  /(^|\/)LICEN[CS]E(\..*)?$/,
  /(^|\/)COPYING(\..*)?$/,
];

const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
  ".woff", ".woff2", ".otf", ".ttf", ".eot",
  ".pdf", ".zip", ".gz", ".webp", ".avif",
  // Office binary formats. They embed stray Unicode codepoints inside
  // their zip-compressed payload that look like forbidden punctuation
  // to a naive byte scan but are not editable text.
  ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt", ".odt",
]);

const files = execSync("git ls-files", { encoding: "utf-8" })
  .trim()
  .split("\n")
  .filter(Boolean);

const findings = [];

for (const file of files) {
  if (SKIP_DIR_PATTERNS.some((p) => p.test(file))) continue;
  if (SKIP_FILE_PATTERNS.some((p) => p.test(file))) continue;
  const dot = file.lastIndexOf(".");
  if (dot !== -1 && SKIP_EXTENSIONS.has(file.slice(dot).toLowerCase())) continue;

  let content;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    continue;
  }
  // Cheap fast-path: skip the line-by-line scan if no forbidden char
  // is in the file at all.
  let hit = false;
  for (const ch of Object.keys(FORBIDDEN)) {
    if (content.includes(ch)) {
      hit = true;
      break;
    }
  }
  if (!hit) continue;

  const lines = content.split("\n");
  lines.forEach((line, idx) => {
    for (const [ch, name] of Object.entries(FORBIDDEN)) {
      if (line.includes(ch)) {
        const preview = line.length > 100 ? line.slice(0, 100) + "..." : line;
        findings.push(`${file}:${idx + 1}: ${name}\n    ${preview}`);
      }
    }
  });
}

if (findings.length > 0) {
  console.error("Forbidden Unicode characters found (per workspace CLAUDE.md):");
  console.error("");
  for (const f of findings) console.error("  " + f);
  console.error("");
  console.error(`Total: ${findings.length} occurrence(s).`);
  console.error("Replace with ASCII equivalents and re-run.");
  process.exit(1);
}

console.log("Unicode hygiene: clean.");
