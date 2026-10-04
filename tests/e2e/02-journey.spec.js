// E2E 02 â€” the PRD Â§15 demo scenario through the browser:
// approve/seed (beforeAll) -> buy -> verify -> approved resale -> cancel/refund -> departure blocks.
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

const FLIGHT = 1;
const FARE = "0.1000";

test.describe("PRD 15 demo journey (browser)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => {
    test.setTimeout(180_000);
    deployAndSeed();
  });

  test.afterAll(() => {
    expect(pageErrors, "pages must log no console/page errors").toEqual([]);
  });

  /** Book a seat on the seeded flight and return the minted token id. */
  async function book(browser, who) {
    const page = await walletPage(browser, who);
    await page.goto(`/checkout.html?flight=${FLIGHT}`);
    await page.waitForSelector("#cred-check", { timeout: 30_000 });
    await waitText(page, "#payment-summary", "Total due now");
    await page.check("#cred-check");
    await page.check("#disclosure");
    await page.waitForSelector("#confirm-btn:not([disabled])", { timeout: 30_000 });
    await page.click("#confirm-btn");
    await page.waitForSelector("#success-panel:not([hidden])", { timeout: 90_000 });
    const shown = norm(await page.textContent("#success-panel"));
    const m = shown.match(/ticket #(\d+)/i);
    expect(m, `success panel: ${shown.slice(0, 200)}`).toBeTruthy();
    return { page, tokenId: Number(m[1]), text: shown };
  }

  test("step 1 - traveler books a seat and receives exactly one NFT ticket", async ({
    browser,
  }) => {
    const page = await walletPage(browser, "traveler");
    await page.goto(`/checkout.html?flight=${FLIGHT}`);
    await page.waitForSelector("#cred-check", { timeout: 30_000 });
    await waitText(page, "#payment-summary", "Total due now");

    // Authoritative refund preview on the confirmation screen (FR-22).
    const checkout = await page.textContent("body");
    expect(checkout).toContain(FARE);
    expect(checkout).toMatch(/0\.0800/);
    expect(checkout).toMatch(/0\.0200/);

    await page.check("#cred-check");
    await page.check("#disclosure");
    await page.waitForSelector("#confirm-btn:not([disabled])");
    await page.click("#confirm-btn");
    await page.waitForSelector("#success-panel:not([hidden])", { timeout: 90_000 });
    const shown = norm(await page.textContent("#success-panel"));
    expect(shown).toMatch(/ticket #1/i);
    expect(shown).toMatch(/0x[0-9a-f]{8,}/i); // hash comes from the wallet receipt
    await shot(page, "05-journey-booking-confirmed");
    await closeQuiet(page);
  });

  test("step 2 - wallet and public verifier expose state without personal data", async ({
    browser,
  }) => {
    const wallet = await walletPage(browser, "traveler");
    await wallet.goto("/tickets.html");
    await wallet.waitForSelector('article[data-token="1"]', { timeout: 45_000 });
    const card = norm(await text(wallet, 'article[data-token="1"]'));
    expect(card).toMatch(/Issued/);
    expect(card).toMatch(/S-1/);
    expect(card).toMatch(/mock fallback|IPFS/); // CID source is tagged, never implied
    await shot(wallet, "06-journey-ticket-wallet");
    await closeQuiet(wallet);

    const verify = await walletPage(browser, "guest", "guest");
    await verify.goto(`/verify.html?ticketId=1`);
    await waitText(verify, "#verify-result", "Issued");
    const result = await text(verify, "#verify-result");
    expect(result).toMatch(/Issued/);
    expect(result).toMatch(/S-1/);
    expect(result).toMatch(/No passenger name, passport, credential/i); // FR-32 disclosure
    expect(result).not.toMatch(/@/); // no e-mail address in the verifier surface
    const privacy = await verify.textContent("#privacy-title");
    expect(privacy).toContain("never shows");
    await shot(verify, "07-journey-verify-issued");
    await closeQuiet(verify);
  });

  test("step 3 - resale listing enforces the 120% cap before publishing", async ({ browser }) => {
    const page = await walletPage(browser, "traveler");
    await page.goto("/tickets.html");
    await page.waitForSelector('[data-action="list"][data-token="1"]', { timeout: 45_000 });
    await page.click('[data-action="list"][data-token="1"]');
    await page.waitForSelector(".modal-backdrop #list-price", { timeout: 30_000 });

    const split = norm(await text(page, ".modal-backdrop #list-split"));
    expect(split).toMatch(/Airline royalty/);
    expect(split).toMatch(/You receive/);

    await page.fill(".modal-backdrop #list-price", "0.15");
    await waitText(page, ".modal-backdrop #list-hint", "may not exceed");
    expect(await page.isDisabled('.modal-backdrop [data-role="ok"]')).toBe(true);

    await page.fill(".modal-backdrop #list-price", "0.11");
    await waitText(page, ".modal-backdrop #list-hint", "moves to");
    await page.click('.modal-backdrop [data-role="ok"]');
    await page.waitForSelector("#cancel-result:not([hidden])", { timeout: 60_000 });
    expect(await text(page, "#cancel-result")).toMatch(/Ticket #1 is now listed/);
    await waitText(page, 'article[data-token="1"]', "Listed");
    await shot(page, "08-journey-listing-published");
    await closeQuiet(page);
  });

  test("step 4 - a third wallet buys the ticket and the split settles exactly", async ({
    browser,
  }) => {
    const guest = await walletPage(browser, "guest", "guest");
    await guest.goto("/marketplace.html");
    await guest.waitForSelector("[data-buy]", { timeout: 45_000 });
    const card = norm(await text(guest, "[data-listing-card]"));
    expect(card).toMatch(/#1\b/);
    expect(card).toMatch(/royalty/i);
    await guest.fill("#filter-max-price", "0.05");
    await waitText(guest, "#listings-grid", "No eligible listings match");
    await guest.click("#filter-clear");
    await guest.waitForSelector("[data-buy]", { timeout: 30_000 });
    await closeQuiet(guest);

    const buyer = await walletPage(browser, "buyer");
    await buyer.goto("/marketplace.html");
    await buyer.waitForSelector("[data-buy]", { timeout: 45_000 });
    await buyer.click("[data-buy]");
    await buyer.waitForSelector('.modal-backdrop [data-role="ok"]', { timeout: 30_000 });
    const modal = norm(await text(buyer, ".modal-backdrop"));
    expect(modal).toMatch(/Listing price/);
    expect(modal).toMatch(/Seller receives/);
    expect(modal).toMatch(/New owner/i);
    await buyer.click('.modal-backdrop [data-role="ok"]');
    await buyer.waitForSelector("#buy-result:not([hidden])", { timeout: 90_000 });

    // Exact wei split: 0.0055 royalty + 0.1045 proceeds = 0.1100 price (metric 6).
    const res = norm(await text(buyer, "#buy-result"));
    expect(res).toMatch(/Purchased ticket/i);
    expect(res).toMatch(/0\.0055/);
    expect(res).toMatch(/0\.1045/);
    expect(res).toMatch(new RegExp(ACCOUNTS.buyer.slice(0, 10), "i"));
    expect(res).toMatch(/0x[0-9a-f]{8,}/i);
    await shot(buyer, "09-journey-resale-settled");
    await buyer.waitForFunction(() => !document.querySelector("[data-buy]"), null, {
      timeout: 45_000,
    });
    await closeQuiet(buyer);
  });

  test("step 5 - airline dashboard reports the settled resale royalty", async ({ browser }) => {
    const page = await walletPage(browser, "airline");
    await page.goto("/airline.html");
    await page.waitForSelector("#resale-card", { timeout: 45_000 });
    await waitText(page, "#stat-resales", "1");
    expect(norm(await text(page, "#stat-resales"))).toBe("1");
    const royalty = norm(await text(page, "#stat-royalty"));
    expect(royalty).not.toBe("-");
    expect(royalty.replace(/[^0-9]/g, "")).toMatch(/[1-9]/);
    const rows = await page.$$("#resale-body tr");
    expect(rows.length).toBe(1);
    await shot(page, "10-journey-airline-royalty");
    await closeQuiet(page);
  });

  test("step 6 - buyer and seller histories both record the resale", async ({ browser }) => {
    const buyer = await walletPage(browser, "buyer");
    await buyer.goto("/tickets.html");
    await buyer.waitForSelector('article[data-token="1"]', { timeout: 45_000 });
    expect(norm(await text(buyer, 'article[data-token="1"]'))).toMatch(/Issued/);
    await buyer.selectOption("#history-filter", "sale");
    await waitText(buyer, "#history-body", "bought for");
    expect(await text(buyer, "#history-body")).toMatch(/bought for/i);
    await closeQuiet(buyer);

    const seller = await walletPage(browser, "traveler");
    await seller.goto("/tickets.html");
    await seller.waitForSelector("#history-filter", { timeout: 45_000 });
    expect(await seller.$('article[data-token="1"]')).toBeNull(); // sold, no longer owned
    await seller.selectOption("#history-filter", "sale");
    await waitText(seller, "#history-body", "sold for");
    expect(await text(seller, "#history-body")).toMatch(/sold for/i);
    await closeQuiet(seller);
  });

  test("step 7 - a second ticket cancels for the policy refund", async ({ browser }) => {
    const booked = await book(browser, "traveler");
    expect(booked.tokenId).toBe(2);
    await closeQuiet(booked.page);

    const page = await walletPage(browser, "traveler");
    await page.goto("/tickets.html");
    await page.waitForSelector('[data-action="cancel"][data-token="2"]', { timeout: 45_000 });
    await page.click('[data-action="cancel"][data-token="2"]');
    await page.waitForSelector('.modal-backdrop [data-role="ok"]', { timeout: 30_000 });

    // Preview modal repeats the contract math before anything is sent.
    const modal = norm(await text(page, ".modal-backdrop"));
    expect(modal).toMatch(/Refund back to you/);
    expect(modal).toMatch(/0\.0800/);
    expect(modal).toMatch(/Airline retains/);
    expect(modal).toMatch(/0\.0200/);

    await page.click('.modal-backdrop [data-role="ok"]');
    await page.waitForSelector("#cancel-result:not([hidden])", { timeout: 90_000 });
    const res = norm(await text(page, "#cancel-result"));
    expect(res).toMatch(/Ticket #2 cancelled/);
    expect(res).toMatch(/Cancelled/);
    expect(res).toMatch(/Refund paid to you/);
    expect(res).toMatch(/0\.0800/);
    expect(res).toMatch(/0\.0200/);
    expect(res).toMatch(/0x[0-9a-f]{8,}/i);
    await page.waitForSelector('#past-list article[data-token="2"]', { timeout: 30_000 });
    await shot(page, "11-journey-cancel-refund");
    await closeQuiet(page);
  });

  test("step 8 - the resold ticket relists and a fresh seat is booked", async ({ browser }) => {
    const seller = await walletPage(browser, "buyer");
    await seller.goto("/tickets.html");
    await seller.waitForSelector('[data-action="list"][data-token="1"]', { timeout: 45_000 });
    await seller.click('[data-action="list"][data-token="1"]');
    await seller.waitForSelector(".modal-backdrop #list-price", { timeout: 30_000 });
    await seller.fill(".modal-backdrop #list-price", "0.105");
    await seller.click('.modal-backdrop [data-role="ok"]');
    await seller.waitForSelector('[data-action="cancel-listing"][data-token="1"]', {
      timeout: 60_000,
    });
    await closeQuiet(seller);

    const booked = await book(browser, "traveler");
    expect(booked.tokenId).toBe(3);
    await closeQuiet(booked.page);
  });

  test("step 9 - once departed, resale, cancellation and booking are blocked", async ({
    browser,
  }) => {
    // Operator marks the flight departed (pause-equivalent terminal guard for the demo).
    const airline = await walletPage(browser, "airline");
    await airline.goto("/airline.html");
    await airline.waitForSelector(`[data-action="depart"][data-flight="${FLIGHT}"]`, {
      timeout: 45_000,
    });
    await airline.click(`[data-action="depart"][data-flight="${FLIGHT}"]`);
    await confirmOk(airline);
    await airline.waitForFunction(
      (f) => !document.querySelector(`[data-action="depart"][data-flight="${f}"]`),
      String(FLIGHT),
      { timeout: 60_000 }
    );
    await shot(airline, "12-journey-flight-departed");
    await closeQuiet(airline);

    // 1) The active resale listing can no longer be bought.
    const guest = await walletPage(browser, "guest", "guest");
    await guest.goto("/marketplace.html");
    const card = guest.locator("[data-listing-card]", { hasText: "#1" });
    await card.locator("[data-buy]").waitFor({ timeout: 45_000 });
    expect(await card.locator("[data-buy]").isDisabled()).toBe(true);
    expect((await card.locator("[data-buy]").getAttribute("title")) || "").toMatch(/departed/i);
    await shot(guest, "13-journey-resale-blocked");
    await closeQuiet(guest);

    // 2) Booking the departed flight is refused on the checkout page.
    const checkout = await walletPage(browser, "traveler");
    await checkout.goto(`/checkout.html?flight=${FLIGHT}`);
    await waitText(checkout, "#page-notices", "already departed");
    expect(await text(checkout, "#page-notices")).toMatch(/already departed/i);
    await closeQuiet(checkout);

    // 3) Cancelling the still-Issued ticket #3 is disabled with the departure reason.
    const canceller = await walletPage(browser, "traveler");
    await canceller.goto("/tickets.html");
    await canceller.waitForSelector('[data-action="cancel"][data-token="3"]', { timeout: 45_000 });
    const cancelBtn = canceller.locator('[data-action="cancel"][data-token="3"]');
    expect(await cancelBtn.isDisabled()).toBe(true);
    expect((await cancelBtn.getAttribute("title")) || "").toMatch(/already departed/i);
    await shot(canceller, "14-journey-cancel-blocked");
    await closeQuiet(canceller);
  });
});
