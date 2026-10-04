// Shared helpers for the tracked Playwright E2E suite: wallet-shimmed pages, DOM helpers,
// screenshot capture, and the deterministic deploy + seed step from scripts/lib/stack.js.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const SHOTS = path.join(ROOT, "doc", "screenshots", "phase6");

// Deterministic Hardhat accounts (mnemonic "test test ... junk", index 0-5).
export const ACCOUNTS = {
  admin: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  airline: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  traveler: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  buyer: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  newcomer: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
};

const SHIM = readFileSync(path.join(ROOT, "tests", "e2e", "helpers", "shim.js"), "utf8");
const IGNORE = /favicon|Failed to load resource|net::ERR_|ERR_ABORTED/i;

/** Console + page errors collected from every helper page in this worker. */
export const pageErrors = [];

export function norm(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

export async function text(page, sel) {
  return norm(await page.textContent(sel).catch(() => ""));
}

/** Wait until an element's innerText contains a substring. */
export async function waitText(page, sel, substr, timeout = 45_000) {
  await page.waitForFunction(
    ([s, t]) => {
      const el = document.querySelector(s);
      return !!el && (el.innerText || "").includes(t);
    },
    [sel, substr],
    { timeout }
  );
}

/** Accept the currently open confirmation modal. */
export async function confirmOk(page) {
  await page.waitForSelector('.modal-backdrop [data-role="ok"]', { timeout: 30_000 });
  await page.click('.modal-backdrop [data-role="ok"]');
}

/** A fresh browser context running the wallet shim as `who` (or guest mode). */
export async function walletPage(browser, who, mode = "connected") {
  const ctx = await browser.newContext();
  await ctx.addInitScript(
    ({ account, m }) => {
      window.__WALLET_ACCOUNT = account;
      window.__WALLET_MODE = m;
    },
    { account: ACCOUNTS[who] || null, m: mode }
  );
  await ctx.addInitScript(SHIM);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(`console: ${m.text()}`);
  });
  page.__errs = errs;
  return page;
}

/** Close a helper page, folding its console noise into the shared error list. */
export async function closeQuiet(page) {
  const errs = (page.__errs || []).filter((e) => !IGNORE.test(e));
  pageErrors.push(...errs);
  if (!page.context().isClosed()) await page.context().close();
}

/** Full-page capture into doc/screenshots/phase6/ (evidence for STATUS / paper). */
export async function shot(page, name) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

/** Deploy the five contracts and seed the deterministic PRD §15 dataset on the running node. */
export function deployAndSeed() {
  const run = (cmd) => {
    const res = spawnSync(cmd, { cwd: ROOT, shell: true, stdio: "inherit" });
    if (res.status !== 0) throw new Error(`${cmd} exited with ${res.status}`);
  };
  run("npm run deploy -- --network localhost");
  run("npm run seed -- --network localhost");
}
