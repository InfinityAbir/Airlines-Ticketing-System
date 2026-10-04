// E2E 03 â€” administrator controls: role gating, approvals, limits, and the pause matrix.
import { test, expect } from "@playwright/test";
import {
  ACCOUNTS,
  closeQuiet,
  confirmOk,
  deployAndSeed,
  norm,
  pageErrors,
  shot,
  text,
  waitText,
  walletPage,
} from "./helpers/fixtures.js";

async function openAdmin(browser, who, mode) {
  const page = await walletPage(browser, who, mode);
  await page.goto("/admin.html");
  await page.waitForSelector("#audit-body", { timeout: 45_000 });
  return page;
}

async function hintCounts(page) {
  const hint = await text(page, "#audit-hint");
  const m = hint.match(/(\d+)\s+of\s+(\d+)/);
  return m ? { shown: Number(m[1]), total: Number(m[2]) } : { shown: -1, total: -1 };
}

async function matrixState(page, op) {
  for (const row of await page.$$("#pause-matrix-body tr")) {
    const label = norm(await row.$eval("td:first-child", (e) => e.innerText));
    if (label === op) {
      const cells = await row.$$eval("td", (t) => t.map((e) => e.innerText.trim()));
      return { status: cells[1], by: cells[2] };
    }
  }
  return null;
}

test.describe("administrator controls", () => {
  test.beforeAll(() => {
    test.setTimeout(180_000);
    deployAndSeed();
  });

  test.afterAll(() => {
    expect(pageErrors, "pages must log no console/page errors").toEqual([]);
  });

  test("a non-admin wallet gets a read-only audit view", async ({ browser }) => {
    const page = await openAdmin(browser, "traveler", "connected");
    await waitText(page, "#page-notices", "Not authorized");
    expect(await text(page, "#page-notices")).toMatch(/administrator wallet/i);
    const hidden = await page.evaluate(() => ({
      approvals: document.getElementById("approvals-card").hidden,
      limits: document.getElementById("limits-card").hidden,
      pause: document.getElementById("pause-card").hidden,
    }));
    expect(hidden).toEqual({ approvals: true, limits: true, pause: true });
    const { shown } = await hintCounts(page);
    expect(shown).toBeGreaterThan(0);
    await shot(page, "15-admin-not-authorized");
    await closeQuiet(page);
  });

  test("the admin session renders limits, switches and the coverage matrix", async ({ browser }) => {
    const page = await openAdmin(browser, "admin", "connected");
    await waitText(page, "#page-notices", "Administrator session");
    expect(await text(page, "#stat-flights")).toBe("1");
    expect(await text(page, "#stat-airlines")).toBe("1");
    expect(await text(page, "#stat-platform")).toMatch(/Live/i);

    expect(await page.inputValue("#f-royalty-cap")).toBe("10.00");
    expect(await page.inputValue("#f-refund-cap")).toBe("100.00");
    expect(await text(page, "#limit-royalty-now")).toBe("10.00%");

    for (const id of ["#pause-registry", "#pause-settlement", "#pause-marketplace"]) {
      expect(await text(page, id)).toMatch(/Live/);
    }
    const rows = await page.$$("#pause-matrix-body tr");
    expect(rows.length).toBe(9);
    await shot(page, "16-admin-console");
    await closeQuiet(page);
  });

  test("airline approval round trip: approve, deactivate, reactivate", async ({ browser }) => {
    const page = await openAdmin(browser, "admin", "connected");
    await waitText(page, "#approvals-body", "Deactivate");

    await page.fill("#f-wallet", "0x123");
    await page.click("#approve-btn");
    await page.waitForSelector("[data-error-for=f-wallet]", { timeout: 15_000 });
    expect(await text(page, "[data-error-for=f-wallet]")).toMatch(/valid address/i);
    expect(await page.$(".modal-backdrop")).toBeNull(); // no tx is attempted

    await page.fill("#f-wallet", ACCOUNTS.airline);
    await page.click("#approve-btn");
    expect(await text(page, "[data-error-for=f-wallet]")).toMatch(/already approved/i);

    await page.fill("#f-wallet", ACCOUNTS.newcomer);
    await page.click("#approve-btn");
    await confirmOk(page);
    await waitText(page, "#approvals-body", "0x9965507D");
    const rows = await page.$$eval("#approvals-body tr", (rs) => rs.map((r) => r.innerText));
    expect(rows.some((r) => /0x9965507D/.test(r) && /Approved/.test(r))).toBe(true);
    expect(await text(page, ".toast.is-success")).toMatch(/Airline operator approved/i);
    expect(await page.inputValue("#f-wallet")).toBe("");
    expect(await text(page, "#stat-airlines")).toBe("2");
    await shot(page, "17-admin-approve-wallet");

    const row = page.locator("#approvals-body tr", { hasText: "0x9965507D" });
    await row.locator('[data-admin-action="deactivate"]').click();
    await confirmOk(page);
    await waitText(page, "#approvals-body", "Disabled");
    expect(norm(await row.innerText())).toMatch(/Disabled/);
    expect(norm(await row.innerText())).toMatch(/Reactivate/);

    await row.locator('[data-admin-action="reactivate"]').click();
    await confirmOk(page);
    await page.waitForFunction(
      () => {
        const row = [...document.querySelectorAll("#approvals-body tr")].find((r) =>
          r.innerText.includes("0x9965507D")
        );
        return !!row && row.innerText.includes("Approved");
      },
      null,
      { timeout: 60_000 }
    );
    expect(norm(await row.innerText())).toMatch(/Approved/);
    expect(norm(await row.innerText())).toMatch(/Deactivate/);
    await closeQuiet(page);
  });

  test("platform limits save on-chain and reject out-of-range input", async ({ browser }) => {
    const page = await openAdmin(browser, "admin", "connected");
    await waitText(page, "#limit-royalty-now", "10.00%");

    await page.fill("#f-royalty-cap", "5");
    await page.click("#limits-btn");
    await confirmOk(page);
    await waitText(page, "#limit-royalty-now", "5.00%");
    expect(await text(page, ".toast.is-success")).toMatch(/Platform limits updated/i);

    await page.fill("#f-refund-cap", "101");
    await page.click("#limits-btn");
    expect(await text(page, "[data-error-for=f-refund-cap]")).toMatch(/Between 0% and 100%/i);
    expect(await page.$(".modal-backdrop")).toBeNull();

    await page.fill("#f-refund-cap", "100");
    await page.fill("#f-royalty-cap", "5.555");
    await page.click("#limits-btn");
    expect(await text(page, "[data-error-for=f-royalty-cap]")).toMatch(/2 decimal places/i);

    await page.fill("#f-royalty-cap", "10");
    await page.click("#limits-btn");
    await confirmOk(page);
    await waitText(page, "#limit-royalty-now", "10.00%");
    await closeQuiet(page);
  });

  test("platform pause blocks the matrix while cancel, boarding and reads stay live", async ({
    browser,
  }) => {
    const admin = await openAdmin(browser, "admin", "connected");
    await waitText(admin, "#btn-registry", "Pause platform");
    const guest = await walletPage(browser, "guest", "guest");
    await guest.goto("/flights.html");
    await guest.waitForSelector("#flights-grid", { timeout: 30_000 });

    await admin.click("#btn-registry");
    await confirmOk(admin);
    await waitText(admin, "#pause-registry", "Paused");
    expect(await text(admin, "#btn-registry")).toBe("Resume platform");
    expect(await text(admin, "#stat-platform")).toMatch(/Paused/i);

    const create = await matrixState(admin, "Create or publish a flight");
    const buy = await matrixState(admin, "Buy a ticket");
    const list = await matrixState(admin, "List a ticket for resale");
    const cancel = await matrixState(admin, "Cancel and refund a ticket");
    const used = await matrixState(admin, "Mark a ticket used (boarding)");
    const reads = await matrixState(admin, "Reads, verification and this feed");
    expect(create.status).toMatch(/Blocked/);
    expect(buy.status).toMatch(/Blocked/);
    expect(list.status).toMatch(/Blocked/);
    expect(cancel.status).toMatch(/Available/);
    expect(used.status).toMatch(/Available/);
    expect(reads.status).toMatch(/Available/);
    await shot(admin, "18-admin-platform-paused");

    await guest.reload();
    await waitText(guest, "#page-notices", "Platform paused");
    expect(await text(guest, "#page-notices")).toMatch(/Platform paused/i);
    await closeQuiet(guest);

    await admin.click("#btn-registry");
    await confirmOk(admin);
    await waitText(admin, "#btn-registry", "Pause platform");
    const after = await matrixState(admin, "Buy a ticket");
    expect(after.status).toMatch(/Available/);
    expect(await text(admin, "#page-notices")).not.toMatch(/Platform paused/i);
    await shot(admin, "19-admin-platform-resumed");
    await closeQuiet(admin);
  });
});
