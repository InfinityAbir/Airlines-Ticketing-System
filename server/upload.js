// R1 protected IPFS upload endpoint (ARCHITECTURE.md §2/§7, decision D-05).
//
// - Plain Node http server, no framework, no dependencies.
// - Provider credentials live ONLY in server/.env (git-ignored) or process env; they are
//   never echoed back, never logged, and never shipped to the browser.
// - POST /api/upload  { ...fictional, non-sensitive JSON... } -> { cid, source }
//     source = "ipfs"  -> uploaded through the configured provider
//     503 ipfs-not-configured / 502 ipfs-unavailable -> the frontend falls back to its
//       deterministic client-side mock CID tagged `mock fallback`.
// - GET  /api/health  -> { ok, ipfsConfigured } so the UI can show endpoint status.
// - Limits: application/json only, 8 KB max, PII-shaped field names rejected (FR-15/17/20).
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/// @notice Maximum accepted request body (fictional metadata is tiny).
export const MAX_BODY_BYTES = 8 * 1024;
/// @notice Provider upload timeout (ms).
const PROVIDER_TIMEOUT_MS = 15000;

/// @notice Field names (normalised: lowercase, alphanumeric only) that look like PII.
const PII_KEY_DENYLIST = new Set([
  "passport",
  "name",
  "fullname",
  "firstname",
  "lastname",
  "email",
  "phone",
  "mobile",
  "dob",
  "birthdate",
  "dateofbirth",
  "nationality",
  "ssn",
  "nid",
  "nationalid",
  "address",
  "photo",
  "document",
  "signature",
  "credential",
]);

/// @notice Read server/.env (if present) without overriding real process env values.
export function loadEnv(base = process.env) {
  const env = { ...base };
  const file = path.join(HERE, ".env");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      if (!(match[1] in env)) env[match[1]] = value;
    }
  }
  return env;
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/// @notice Recursively find the first PII-shaped field name; returns null when clean.
export function findPiiField(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findPiiField(item);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (PII_KEY_DENYLIST.has(normalizeKey(key))) return key;
      const hit = findPiiField(child);
      if (hit) return hit;
    }
  }
  return null;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        const err = new Error("payload too large");
        err.code = "PAYLOAD_TOO_LARGE";
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!done) reject(err);
    });
  });
}

const CID_SHAPE = /^[A-Za-z0-9]{8,128}$/;

/// @notice One-shot JSON POST without keep-alive (`agent: false`).
/// @dev Deliberately node:http/https rather than fetch: the global fetch pool keeps
///      sockets alive, which trips a libuv teardown assertion under forced exits.
function postJson(urlString, { headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch {
      reject(new Error("invalid IPFS_PROVIDER_URL"));
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new Error("unsupported provider protocol"));
      return;
    }
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers,
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("provider timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/// @notice POST the metadata to the configured IPFS provider and return its CID.
async function uploadToProvider(env, content) {
  const result = await postJson(env.IPFS_PROVIDER_URL, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.IPFS_API_KEY}`,
    },
    // Provider contract (documented in server/.env.example): JSON { name, content }
    // -> JSON containing cid | hash | IpfsHash.
    body: JSON.stringify({ name: `ticket-metadata-${Date.now()}.json`, content }),
    timeoutMs: PROVIDER_TIMEOUT_MS,
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`provider responded ${result.status}`);
  }
  let data = null;
  try {
    data = JSON.parse(result.body);
  } catch {
    data = null;
  }
  const cid =
    data &&
    (data.cid ||
      data.hash ||
      data.IpfsHash ||
      (data.value && (data.value.cid || data.value.Hash)));
  if (typeof cid !== "string" || !CID_SHAPE.test(cid)) {
    throw new Error("provider response missing a usable CID");
  }
  return cid;
}

function ipfsConfigured(env) {
  return Boolean(env.IPFS_PROVIDER_URL && env.IPFS_PROVIDER_URL.trim() &&
    env.IPFS_API_KEY && env.IPFS_API_KEY.trim());
}

/// @notice Build the http request handler bound to the given env.
export function createUploadApp(env = loadEnv()) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      const url = new URL(req.url, "http://localhost");

      if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          ipfsConfigured: ipfsConfigured(env),
          maxBodyBytes: MAX_BODY_BYTES,
        });
        return;
      }

      if (url.pathname !== "/api/upload") {
        sendJson(res, 404, { error: "not-found" });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method-not-allowed" }, { Allow: "GET, POST, OPTIONS" });
        return;
      }

      const contentType = String(req.headers["content-type"] || "");
      if (!contentType.toLowerCase().includes("application/json")) {
        sendJson(res, 415, {
          error: "unsupported-media-type",
          message: "Send application/json only — fictional, non-sensitive ticket metadata.",
        });
        return;
      }

      let raw;
      try {
        raw = await readBody(req);
      } catch (err) {
        if (err.code === "PAYLOAD_TOO_LARGE") {
          // Already discarding the remaining stream (readBody stops buffering);
          // answer early and leave the socket alone so teardown stays clean.
          sendJson(res, 413, {
            error: "payload-too-large",
            message: `Metadata must be ${MAX_BODY_BYTES} bytes or less.`,
          });
          return;
        }
        throw err;
      }

      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "invalid-json" });
        return;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        sendJson(res, 400, { error: "invalid-json", message: "Body must be a JSON object." });
        return;
      }

      const piiField = findPiiField(payload);
      if (piiField) {
        sendJson(res, 400, {
          error: "pii-field",
          field: piiField,
          message: "PII-shaped fields are not allowed in ticket metadata (FR-15/FR-17).",
        });
        return;
      }

      if (!ipfsConfigured(env)) {
        sendJson(res, 503, {
          error: "ipfs-not-configured",
          code: "ipfs-not-configured",
          message:
            "IPFS provider credentials are not configured on this server (server/.env). " +
            "The client will record a mock fallback CID instead.",
        });
        return;
      }

      let cid;
      try {
        cid = await uploadToProvider(env, raw);
      } catch (err) {
        sendJson(res, 502, {
          error: "ipfs-unavailable",
          code: "ipfs-unavailable",
          message: `IPFS provider upload failed (${err.message}). The client may fall back to a mock CID.`,
        });
        return;
      }

      sendJson(res, 200, { cid, source: "ipfs" });
    } catch (err) {
      sendJson(res, 500, { error: "server-error", message: String(err.message || err) });
    }
  });
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const env = loadEnv();
  const port = Number(env.PORT || 8787);
  const host = env.HOST || "127.0.0.1";
  createUploadApp(env).listen(port, host, () => {
    console.log(
      `upload service listening on http://${host}:${port}/api/upload ` +
        `(ipfs configured: ${ipfsConfigured(env) ? "yes" : "no"})`
    );
  });
}
