// marketplace.html — public resale catalogue and buy flow (DESIGN.md §3.5, FR-26/27/28/30).
// Reads are wallet-less (Wallet.readPublic); buying runs connect + chain check → confirm modal
// → atomic buyListing. Direct NFT transfers are deliberately not offered anywhere in this UI.
(function () {
  "use strict";

  const STATE_NAMES = ["Issued", "Listed", "Cancelled", "Refunded", "Used", "Invalid"];
  const grid = document.getElementById("listings-grid");
  const resultCount = document.getElementById("result-count");
  const notices = document.getElementById("page-notices");
  const progressEl = document.getElementById("tx-progress");
  const resultEl = document.getElementById("buy-result");

  let rows = [];
  let splits = new Map();
  let platformPaused = false;
  let chainNow = 0;
  let loading = false;
  let submitting = false;

  function setNotice(html) {
    notices.innerHTML = html || "";
  }

  function showConfigNotice() {
    setNotice(
      '<div class="notice notice-danger"><strong>Contract configuration missing.</strong> ' +
        'Run <code>npm run deploy</code> in the project root, then reload this page.</div>'
    );
    grid.innerHTML = "";
    resultCount.textContent = "—";
  }

  /// @notice Contract-computed split for a listing price (display-only mirror of buyListing).
  async function priceSplit(listing) {
    const marketplace = Wallet.readPublic("TicketMarketplace");
    const p = await marketplace.previewResale(listing.tokenId, listing.priceWei);
    return p;
  }

  /// @notice Why this listing cannot be bought right now, or null when it is buyable.
  function buyBlockReason(row) {
    const { listing, ticket, flight } = row;
    if (platformPaused) return "The platform is paused — buying is disabled for now.";
    if (!flight) return "Flight details are unavailable for this listing.";
    if (flight.cancelled) return "This flight was cancelled, so its tickets cannot be resold.";
    if (flight.departed) return "This flight has already departed, so its tickets cannot be resold.";
    if (chainNow && Number(flight.refundDeadline) < chainNow) {
      return `Resale closed: the refund deadline passed (${UI.timestampText(flight.refundDeadline)}).`;
    }
    if (Number(ticket.state) !== 1) {
      return `This ticket is ${STATE_NAMES[Number(ticket.state)] || "Invalid"} — the listing is no longer purchasable.`;
    }
    const me = Wallet.state.address;
    if (me && me.toLowerCase() === listing.seller.toLowerCase()) {
      return "You created this listing — withdraw it from My Tickets instead.";
    }
    return null;
  }

  function cardHtml(row, split) {
    const { listing, ticket, flight } = row;
    const tokenId = Number(listing.tokenId);
    const reason = buyBlockReason(row);
    const royaltyPct = (Number(split.royaltyBps) / 100).toFixed(1).replace(/\.0$/, "");
    const route = flight
      ? `${UI.escapeHtml(flight.origin)} <span class="arrow" aria-hidden="true">→</span> ${UI.escapeHtml(flight.destination)}`
      : "Route unavailable";
    const code = flight ? UI.escapeHtml(flight.flightCode) : "—";
    const stateLabel = STATE_NAMES[Number(ticket.state)] || "Invalid";

    return `
      <article class="flight-card${reason ? " is-disabled" : ""}" data-listing-card="${listing.listingId}">
        <div class="flight-head">
          <span class="flight-code">#${tokenId} · ${code}</span>
          <span class="badge badge-listed">Listed</span>
        </div>
        <div class="route">${route}</div>
        <div class="flight-meta">
          <span><span class="label">Departure</span><br>${flight ? UI.formatTimestamp(flight.departureTime) : "—"}</span>
          <span><span class="label">Seat</span><br><span class="mono">${UI.escapeHtml(ticket.seatReference)}</span></span>
          <span><span class="label">Seller</span><br><span class="mono">${UI.shortAddress(listing.seller)}</span></span>
          <span><span class="label">Listing expires</span><br>${UI.formatTimestamp(listing.expiresAt)}</span>
          <span><span class="label">Airline royalty (${royaltyPct}%)</span><br>${UI.ethFormat(split.royalty)}</span>
          <span><span class="label">Seller receives</span><br>${UI.ethFormat(split.sellerProceeds)}</span>
        </div>
        <div class="xsmall muted">
          Listing #${listing.listingId} · opened ${UI.formatTimestamp(listing.createdAt)} ·
          ticket state ${stateLabel}
        </div>
        <div class="flight-foot">
          <span class="price" title="${listing.priceWei} wei">${UI.ethFormat(listing.priceWei)}</span>
          <button type="button" class="btn btn-primary" data-buy="${listing.listingId}"${reason ? ` disabled title="${UI.escapeHtml(reason)}"` : ""}>
            ${reason ? "Unavailable" : "Buy ticket"}
          </button>
        </div>
        ${reason ? `<div class="xsmall muted">${UI.escapeHtml(reason)}</div>` : ""}
      </article>`;
  }

  function applyFilters(list) {
    const route = document.getElementById("filter-route").value.trim().toUpperCase();
    const maxPriceEth = document.getElementById("filter-max-price").value.trim();
    const airline = document.getElementById("filter-airline").value;
    let maxWei = null;
    if (maxPriceEth !== "") {
      try {
        maxWei = window.ethers.parseEther(maxPriceEth);
      } catch {
        maxWei = null;
      }
    }
    return list.filter((row) => {
      const { listing, flight } = row;
      if (route) {
        const hay = flight ? `${flight.origin} ${flight.destination} ${flight.flightCode}` : "";
        if (!String(hay).toUpperCase().includes(route)) return false;
      }
      if (maxWei != null && listing.priceWei > maxWei) return false;
      if (airline && (!flight || flight.airline.toLowerCase() !== airline.toLowerCase())) return false;
      return true;
    });
  }

  function renderAirlines() {
    const select = document.getElementById("filter-airline");
    const current = select.value;
    const seen = new Map();
    rows.forEach((row) => {
      if (row.flight && !seen.has(row.flight.airline)) seen.set(row.flight.airline, null);
    });
    select.innerHTML =
      '<option value="">All operators</option>' +
      [...seen.keys()]
        .map(
          (addr) =>
            `<option value="${UI.escapeHtml(addr)}">${UI.escapeHtml(UI.shortAddress(addr, 10, 8))}</option>`
        )
        .join("");
    if (current && seen.has(current)) select.value = current;
  }

  function render() {
    const visible = applyFilters(rows);
    resultCount.textContent =
      `${visible.length} listing${visible.length === 1 ? "" : "s"}` +
      (visible.length !== rows.length ? ` (of ${rows.length} total)` : "");

    if (visible.length === 0) {
      grid.innerHTML =
        '<div class="notice empty-state" style="grid-column:1/-1">' +
        (rows.length === 0
          ? "No eligible listings. List a ticket for resale from My Tickets."
          : "No eligible listings match these filters.") +
        "</div>";
      return;
    }
    grid.innerHTML = visible
      .map((row) => {
        const split = splits.get(Number(row.listing.listingId));
        return split ? cardHtml(row, split) : "";
      })
      .join("");
  }

  async function load() {
    if (loading) return;
    loading = true;
    resultCount.textContent = "Loading…";
    try {
      if (Wallet.configMissing()) {
        showConfigNotice();
        return;
      }
      const marketplace = Wallet.readPublic("TicketMarketplace");
      const nft = Wallet.readPublic("AirTicketNFT");
      const inventory = Wallet.readPublic("FlightInventory");
      const registry = Wallet.readPublic("AirlineRegistry");

      // Two independent pause sources: AirlineRegistry and this contract's own Pausable.
      // The contracts revert on `paused() || registry.paused()`, so the UI must mirror both.
      const [registryPaused, localPaused, latestBlock, listings] = await Promise.all([
        registry.paused().catch(() => false),
        marketplace.paused().catch(() => false),
        marketplace.runner.getBlock("latest"),
        marketplace.getActiveListings(),
      ]);
      platformPaused = registryPaused || localPaused;
      chainNow = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);

      const loaded = await Promise.all(
        listings.map(async (listing) => {
          try {
            const ticket = await nft.getTicket(listing.tokenId);
            const flight = await inventory.getFlight(ticket.flightId).catch(() => null);
            return { listing, ticket, flight };
          } catch {
            return null;
          }
        })
      );
      rows = loaded.filter(Boolean);

      if (platformPaused) {
        setNotice(
          '<div class="notice notice-warn"><strong>Platform paused.</strong> ' +
            "Listings stay visible, but buying and listing are disabled until it is unpaused.</div>"
        );
      } else {
        setNotice("");
      }

      renderAirlines();

      splits = new Map();
      await Promise.all(
        rows.map(async (row) => {
          try {
            splits.set(Number(row.listing.listingId), await priceSplit(row.listing));
          } catch (err) {
            console.warn("previewResale failed", err);
          }
        })
      );
      render();
    } catch (err) {
      console.error(err);
      setNotice(
        '<div class="notice notice-danger"><strong>Could not load listings.</strong> ' +
          UI.escapeHtml(UI.revertMessage(err)) +
          " Is the Hardhat node running?</div>"
      );
      resultCount.textContent = "—";
    } finally {
      loading = false;
    }
  }

  // ---- Buy flow: connect + chain check → FR-30 breakdown → atomic buyListing ----

  async function onBuyClick(btn) {
    if (submitting) return;
    const listingId = Number(btn.dataset.buy);
    const row = rows.find((r) => Number(r.listing.listingId) === listingId);
    if (!row) return;

    const reason = buyBlockReason(row);
    if (reason) {
      UI.toast("warn", reason);
      return;
    }

    // DESIGN §3.5: connect + chain check before the confirmation modal.
    if (!(await Wallet.requireWrite())) return;

    let split;
    try {
      split = await priceSplit(row.listing);
    } catch (err) {
      UI.toast("error", UI.revertMessage(err, Wallet.allContracts()));
      return;
    }

    const buyer = Wallet.state.address;
    const royaltyPct = (Number(split.royaltyBps) / 100).toFixed(1).replace(/\.0$/, "");
    const confirmed = await UI.confirmModal({
      title: `Buy ticket #${Number(row.listing.tokenId)}?`,
      body: `
        <dl class="kv">
          <dt>Listing price</dt><dd><strong>${UI.ethFormat(row.listing.priceWei)}</strong></dd>
          <dt>Seller receives</dt><dd>${UI.ethFormat(split.sellerProceeds)}</dd>
          <dt>Airline royalty (${royaltyPct}%)</dt><dd>${UI.ethFormat(split.royalty)}</dd>
          <dt>New owner</dt><dd class="mono xsmall">${UI.escapeHtml(buyer)}</dd>
        </dl>
        <p class="xsmall muted mb-0">
          One transaction pays the seller and the airline, moves the ticket NFT to your wallet and
          closes the listing. You send exactly ${UI.ethFormat(row.listing.priceWei)} — nothing more.
        </p>`,
      confirmText: "Buy ticket",
    });
    if (!confirmed) return;
    if (!(await Wallet.requireWrite())) return;

    submitting = true;
    UI.setBusy(btn, true);
    progressEl.hidden = false;
    resultEl.hidden = true;
    resultEl.innerHTML = "";
    const steps = UI.txSteps(progressEl, [
      "Re-read the listing price",
      "Send purchase transaction",
      "Confirm ownership on chain",
    ]);

    try {
      steps.set(0, "active");
      const marketplace = Wallet.readPublic("TicketMarketplace");
      const current = await marketplace.getListing(listingId);
      if (!current.active) throw new Error("listing is no longer active");
      if (current.priceWei !== row.listing.priceWei) throw new Error("listing price changed");
      steps.set(0, "done");

      steps.set(1, "active");
      const write = await Wallet.write("TicketMarketplace");
      const tx = await write.buyListing(listingId, { value: current.priceWei });
      steps.set(1, "done");

      steps.set(2, "active");
      const receipt = await tx.wait();
      if (receipt.status !== 1) throw new Error("transaction reverted");
      steps.set(2, "done");

      let sold = { priceWei: current.priceWei, royalty: split.royalty, sellerProceeds: split.sellerProceeds };
      for (const log of receipt.logs) {
        try {
          const parsed = write.interface.parseLog(log);
          if (parsed && parsed.name === "ListingSold") sold = parsed.args;
        } catch {
          /* log from another contract */
        }
      }

      renderBuyResult({
        listingId,
        tokenId: Number(row.listing.tokenId),
        priceWei: sold.priceWei,
        royalty: sold.royalty,
        sellerProceeds: sold.sellerProceeds,
        newOwner: sold.buyer ?? buyer,
        hash: receipt.hash,
      });
      UI.toast("success", `Ticket #${Number(row.listing.tokenId)} purchased.`, receipt.hash);
      await load();
      resultEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (err) {
      console.error("buy failed", err);
      const msg = UI.revertMessage(err, Wallet.allContracts());
      const failIndex = [0, 1, 2].find((i) => !steps.node.children[i].className.includes("done"));
      steps.fail(failIndex ?? 2, null);
      UI.toast("error", msg);
      progressEl.hidden = false;
    } finally {
      submitting = false;
      UI.setBusy(btn, false);
    }
  }

  function renderBuyResult({ listingId, tokenId, priceWei, royalty, sellerProceeds, newOwner, hash }) {
    resultEl.hidden = false;
    resultEl.innerHTML = `
      <section class="notice notice-success" aria-live="polite">
        <div class="row">
          <strong>Purchased ticket #${tokenId}.</strong>
          ${UI.statusBadge("Issued")}
        </div>
        <dl class="kv mt-3">
          <dt>Listing / price</dt><dd>#${listingId} · ${UI.ethFormat(priceWei)}</dd>
          <dt>Seller received</dt><dd>${UI.ethFormat(sellerProceeds)}</dd>
          <dt>Airline royalty paid</dt><dd>${UI.ethFormat(royalty)}</dd>
          <dt>New owner</dt><dd class="mono xsmall">${UI.escapeHtml(newOwner)}</dd>
          <dt>Transaction hash</dt><dd class="mono xsmall">${UI.escapeHtml(hash)}</dd>
        </dl>
        <div class="btn-row row mt-3">
          <a class="btn btn-primary btn-sm" href="tickets.html">View in My Tickets</a>
          <a class="btn btn-sm" href="${UI.escapeHtml(UI.verifyLink(tokenId))}">Verify publicly</a>
          <button type="button" class="btn btn-sm" id="dismiss-buy-result">Dismiss</button>
        </div>
      </section>`;
    const dismiss = document.getElementById("dismiss-buy-result");
    if (dismiss) dismiss.addEventListener("click", () => (resultEl.hidden = true));
  }

  // ---- Wiring ----

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-buy]");
    if (!btn || btn.disabled) return;
    onBuyClick(btn);
  });

  ["filter-route", "filter-max-price", "filter-airline"].forEach((id) => {
    document.getElementById(id).addEventListener("input", render);
  });
  document.getElementById("filter-clear").addEventListener("click", () => {
    document.getElementById("filter-route").value = "";
    document.getElementById("filter-max-price").value = "";
    document.getElementById("filter-airline").value = "";
    render();
  });
  document.getElementById("refresh-btn").addEventListener("click", load);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", load);
  } else {
    load();
  }
  Wallet.onChange(() => load());
})();
