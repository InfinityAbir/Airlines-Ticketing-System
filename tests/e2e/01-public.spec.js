// E2E 01 â€” public, wallet-less surfaces (fresh deploy + seed, no transactions).
import { test, expect } from "@playwright/test";
import {
  closeQuiet,
  deployAndSeed,
  pageErrors,
  shot,
  text,
  waitText,
  walletPage,
} from "./helpers/fixtures.js";

test.describe("public surfaces (guest)", () => {
  test.beforeAll(() => {
    test.setTimeout(180_000);
    deployAndSeed();
  });

  test.afterAll(() => {
    expect(pageErrors, "pages must log no console/page errors").toEqual([]);
  });

  test("flights page lists the seeded published flight", async ({ browser }) => {
    const page = await walletPage(browser, "guest", "guest");
    await page.goto("/flights.html");
    await page.waitForSelector("#flights-grid", { timeout: 30_000 });
    await waitText(page, "#flights-grid", "R1-DEMO-001");
    const grid = await text(page, "#flights-grid");
    expect(grid).toContain("R1-DEMO-001");
    expect(grid).toMatch(/JFK/);
    expect(grid).toMatch(/LHR/);
    expect(grid).toMatch(/0 of 5 seats booked/);
    expect(grid).toMatch(/0\.1000\s*ETH/);
    await shot(page, "01-flights-guest");
    await closeQuiet(page);
  });

  test("marketplace shows the empty state for a guest", async ({ browser }) => {
    const page = await walletPage(browser, "guest", "guest");
    await page.goto("/marketplace.html");
    await page.waitForSelector("#listings-grid", { timeout: 30_000 });
    await waitText(page, "#listings-grid", "No eligible listings");
    expect(await text(page, "#listings-grid")).toContain("No eligible listings");
    expect(await text(page, "#result-count")).toMatch(/0\s+listing/i);
    await shot(page, "02-marketplace-empty");
    await closeQuiet(page);
  });

  test("verifier reports unknown tickets without exposing personal data", async ({ browser }) => {
    const page = await walletPage(browser, "guest", "guest");
    await page.goto("/verify.html?ticketId=99");
    await waitText(page, "#verify-result", "Not found");
    expect(await text(page, "#verify-result")).toMatch(/Not found/i);
    await shot(page, "03-verify-unknown");

    expect(await text(page, "#privacy-title")).toContain("never shows");
    const privacy = await page.textContent("body");
    expect(privacy).toMatch(/Never shown: passenger names, passport or credential data/i);
    await closeQuiet(page);
  });

  test("admin page gives a guest the public audit view with no write surface", async ({
    browser,
  }) => {
    const page = await walletPage(browser, "guest", "guest");
    await page.goto("/admin.html");
    await page.waitForSelector("#audit-body", { timeout: 45_000 });
    await waitText(page, "#audit-hint", "of");
    expect(await text(page, "#page-notices")).toMatch(/Public audit view/i);

    const hidden = await page.evaluate(() => ({
      approvals: document.getElementById("approvals-card").hidden,
      limits: document.getElementById("limits-card").hidden,
      pause: document.getElementById("pause-card").hidden,
      stats: !document.getElementById("stats-row").hidden,
    }));
    expect(hidden).toEqual({ approvals: true, limits: true, pause: true, stats: true });

    const hint = await text(page, "#audit-hint");
    const total = Number((hint.match(/(\d+)\s+of\s+(\d+)/) || [])[2] || 0);
    expect(total).toBeGreaterThanOrEqual(3);
    const rows = await page.$$eval("#audit-body tr", (rs) => rs.map((r) => r.innerText));
    expect(rows.join(" ")).toMatch(/Airline approved/i);
    expect(rows.join(" ")).toMatch(/Flight published/i);
    expect(rows.every((r) => /0x[0-9a-f]{8,}/i.test(r))).toBe(true);
    await shot(page, "04-admin-public-audit");
    await closeQuiet(page);
  });
});
