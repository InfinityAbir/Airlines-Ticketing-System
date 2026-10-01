// Minimal tracked-secret scanner (Phase 0 gate).
// Fails (exit 1) if likely secrets appear in tracked text files.
// Scans: contracts/, scripts/, test/, frontend/, server/ (excluding generated config + env examples).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = ["contracts", "scripts", "test", "frontend", "server"];
const SKIP = new Set(["contracts-config.js", ".env.example", "scan-secrets.js"]);
const PATTERNS = [
  /0x[a-fA-F0-9]{64}/, // raw 32-byte private key
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /pinata[_-]?api[_-]?key\s*[:=]/i,
  /pinata[_-]?secret/i,
  /x-secret-token|provider.?token\s*[:=]\s*['"][^'"]{8,}/i,
  /mnemonic|seed.?phrase\s*[:=]\s*['"][a-z\s]{20,}/i,
];

let hits = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p);
      continue;
    }
    if (SKIP.has(entry.name)) continue;
    if (!/\.(sol|js|html|css|json|example)$/.test(entry.name)) continue;
    const text = fs.readFileSync(p, "utf8");
    for (const re of PATTERNS) {
      if (re.test(text)) {
        console.error(`secret-scan HIT ${p} :: ${re}`);
        hits += 1;
      }
    }
  }
}

for (const root of ROOTS) {
  const abs = path.join(here, "..", root);
  if (fs.existsSync(abs)) walk(abs);
}
if (hits > 0) {
  console.error(`secret-scan FAILED with ${hits} hit(s)`);
  process.exit(1);
} else {
  console.log("secret-scan OK: no tracked secrets found");
}
