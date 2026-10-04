// E2E 04 — responsive / accessibility polish checks (Phase 6 task 2 evidence).
import { test, expect } from "@playwright/test";
import { closeQuiet, deployAndSeed, pageErrors, walletPage } from "./helpers/fixtures.js";

const PAGES = [
  ["index.html", null],
  ["flights.html", "#flights-grid"],
  ["marketplace.html", "#listings-grid"],
  ["tickets.html", "#history-filter"],
  ["verify.html", "#verify-form"],
  ["airline.html", "#page-notices"],
  ["admin.html", "#audit-body"],
  ["checkout.html?flight=1", "#payment-summary"],
];

test.describe("responsive and accessibility polish", () => {
  test.beforeAll(() => {
    test.setTimeout(180_000);
    deployAndSeed();
  });

  test("every page fits a 375px viewport without horizontal scrolling", async ({ browser }) => {
    for (const [path, ready] of PAGES) {
      const page = await walletPage(browser, "guest", "guest");
      await page.setViewportSize({ width: 375, height: 700 });
      await page.goto(`/${path}`);
      if (ready) {
        // `attached`, not `visible`: a page with no rows renders an empty grid.
        await page.waitForSelector(ready, { state: "attached", timeout: 45_000 });
      }
      await page.waitForTimeout(750);
      const box = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(box.scroll, `${path} overflows horizontally (${box.scroll} > ${box.client})`).toBeLessThanOrEqual(
        box.client + 1
      );
      await closeQuiet(page);
    }
  });

  test("status regions are announced and every input is labelled", async ({ browser }) => {
    const page = await walletPage(browser, "guest", "guest");
    await page.goto("/checkout.html?flight=1");
    await page.waitForSelector("#payment-summary", { timeout: 45_000 });
    const audit = await page.evaluate(() => {
      const controls = [...document.querySelectorAll("input, select, textarea")].filter(
        (el) => !["hidden", "submit", "button"].includes(el.type)
      );
      const unlabelled = controls
        .filter((el) => {
          const byFor = el.id && document.querySelector(`label[for="${el.id}"]`);
          const wrapped = el.closest("label");
          return !byFor && !wrapped && !el.getAttribute("aria-label");
        })
        .map((el) => `${el.tagName}#${el.id || "(no id)"}`);
      return {
        unlabelled,
        hasLiveRegion: !!document.querySelector('[aria-live="polite"]'),
        hasMain: !!document.querySelector("main"),
        hasLang: !!document.documentElement.lang,
        h1: document.querySelectorAll("h1").length,
      };
    });
    expect(audit.unlabelled).toEqual([]);
    expect(audit.hasLiveRegion).toBe(true);
    expect(audit.hasMain).toBe(true);
    expect(audit.hasLang).toBe(true);
    expect(audit.h1).toBeGreaterThanOrEqual(1);
    await closeQuiet(page);
  });

  test("no page logs console errors while loading its public views", () => {
    expect(pageErrors, "pages must log no console/page errors").toEqual([]);
  });
});
