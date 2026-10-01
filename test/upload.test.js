import { expect } from "chai";
import http from "node:http";
import { MAX_BODY_BYTES, createUploadApp, findPiiField, loadEnv } from "../server/upload.js";

// Phase 2: protected upload endpoint. Credentials never appear here — tests drive the
// service with an explicit env (unconfigured / fake local provider) so a developer's
// server/.env can never leak into results.
//
// Uses node:http (Connection: close, no keep-alive pool) instead of fetch: mocha's
// `--exit` force-quits, and lingering undici keep-alive sockets trip a libuv assertion
// on Windows teardown.

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close(() => resolve());
  });
}

function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe("upload service (Phase 2)", function () {
  const servers = [];

  async function startApp(env) {
    const app = createUploadApp(env);
    const port = await listen(app);
    servers.push(app);
    return { app, base: `http://127.0.0.1:${port}` };
  }

  afterEach(async () => {
    while (servers.length) await close(servers.pop());
  });

  it("health reports ipfs configuration status without leaking credentials", async function () {
    const { base } = await startApp({});
    const res = await request(`${base}/api/health`);
    expect(res.status).to.equal(200);
    expect(res.json.ok).to.equal(true);
    expect(res.json.ipfsConfigured).to.equal(false);
    expect(res.text).to.not.include("IPFS_API_KEY");
  });

  it("rejects upload with 503 ipfs-not-configured when no credentials are set", async function () {
    const { base } = await startApp({ IPFS_PROVIDER_URL: "", IPFS_API_KEY: "" });
    const res = await request(`${base}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flightCode: "R1-DEMO-001", fictional: true }),
    });
    expect(res.status).to.equal(503);
    expect(res.json.code).to.equal("ipfs-not-configured");
  });

  it("uploads through the provider and returns { cid, source: 'ipfs' }", async function () {
    let seen = null;
    const provider = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen = {
          auth: req.headers.authorization,
          contentType: req.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ IpfsHash: "QmProviderCid123456789012345678901234567890" }));
      });
    });
    servers.push(provider);
    const providerPort = await listen(provider);

    const { base } = await startApp({
      IPFS_PROVIDER_URL: `http://127.0.0.1:${providerPort}/api/v0/add`,
      IPFS_API_KEY: "unit-test-key",
    });
    const payload = { flightCode: "R1-DEMO-001", fictional: true, travelerWallet: "0xabc" };
    const res = await request(`${base}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).to.equal(200);
    expect(res.json.source).to.equal("ipfs");
    expect(res.json.cid).to.equal("QmProviderCid123456789012345678901234567890");
    // The exact bytes we sent are what gets pinned (fingerprint verification depends on it).
    const providerBody = JSON.parse(seen.body);
    expect(providerBody.content).to.equal(JSON.stringify(payload));
    expect(providerBody.name).to.match(/^ticket-metadata-\d+\.json$/);
    expect(seen.auth).to.equal("Bearer unit-test-key");
    expect(seen.contentType).to.include("application/json");
  });

  it("maps provider failures to 502 ipfs-unavailable", async function () {
    const provider = http.createServer((req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end("{}");
    });
    servers.push(provider);
    const providerPort = await listen(provider);
    const { base } = await startApp({
      IPFS_PROVIDER_URL: `http://127.0.0.1:${providerPort}/api/v0/add`,
      IPFS_API_KEY: "unit-test-key",
    });
    const res = await request(`${base}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flightCode: "R1-DEMO-001" }),
    });
    expect(res.status).to.equal(502);
    expect(res.json.code).to.equal("ipfs-unavailable");
  });

  it("enforces content type, size and JSON shape", async function () {
    const { base } = await startApp({});

    const wrongType = await request(`${base}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(wrongType.status).to.equal(415);

    const tooBig = await request(`${base}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "x".repeat(MAX_BODY_BYTES + 64) }),
    });
    expect(tooBig.status).to.equal(413);

    const badJson = await request(`${base}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).to.equal(400);

    const notObject = await request(`${base}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([1, 2, 3]),
    });
    expect(notObject.status).to.equal(400);

    const noMethod = await request(`${base}/api/upload`, { method: "GET" });
    expect(noMethod.status).to.equal(405);
  });

  it("rejects PII-shaped fields anywhere in the payload (FR-15/FR-17)", async function () {
    const { base } = await startApp({});
    const res = await request(`${base}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flightCode: "R1-DEMO-001", extra: { Passport: "AB123456" } }),
    });
    expect(res.status).to.equal(400);
    expect(res.json.error).to.equal("pii-field");
    expect(res.json.field).to.equal("Passport");

    // Nested clean payloads stay acceptable; wallet addresses are public, not PII.
    expect(findPiiField({ travelerWallet: "0xdeadbeef", seat: "S-1" })).to.equal(null);
    expect(findPiiField({ traveler: { fullName: "Test" } })).to.equal("fullName");
  });

  it("env loader never overrides values already set in the process env", async function () {
    const env = loadEnv({ IPFS_PROVIDER_URL: "http://from-base.example/add" });
    expect(env.IPFS_PROVIDER_URL).to.equal("http://from-base.example/add");
  });

  it("answers CORS preflight for the browser frontend", async function () {
    const { base } = await startApp({});
    const res = await request(`${base}/api/upload`, { method: "OPTIONS" });
    expect(res.status).to.equal(204);
    expect(res.headers["access-control-allow-origin"]).to.equal("*");
    expect(res.headers["access-control-allow-headers"]).to.include("Content-Type");
  });
});
