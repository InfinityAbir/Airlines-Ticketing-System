// tickets.html — ticket wallet: boarding-pass cards, public CID verification (FR-17/18),
// cancellation preview → refund receipt (FR-22/23), and filtered transaction history.
(function () {
  "use strict";

  const ACTIVE_STATES = new Set(["Issued", "Listed"]);
  const STATE_NAMES = ["Issued", "Listed", "Cancelled", "Refunded", "Used", "Invalid"];
  const notices = document.getElementById("page-notices");
  const activeList = document.getElementById("active-list");
  const pastList = document.getElementById("past-list");
  const historyBody = document.getElementById("history-body");
  const historyFilter = document.getElementById("history-filter");
  const resultCount = document.getElementById("result-count");
  const progressEl = document.getElementById("tx-progress");
  const resultEl = document.getElementById("cancel-result");

  let loading = false;
  let submitting = false;
  let historyRows = [];
  let ticketsCache = [];
  let platformPaused = false;
  let chainNow = 0;

  function setNotice(html) {
    notices.innerHTML = html || "";
  }

  /// @notice Why cancel is unavailable, or null when it is allowed (DESIGN §3.4).
  function cancelBlockReason(t, flight) {
    const state = STATE_NAMES[Number(t.state)] || "Invalid";
    if (state !== "Issued") {
      if (state === "Listed") return "Listed for resale — withdraw the listing first.";
      if (state === "Cancelled") return "This ticket is already cancelled.";
      if (state === "Used") return "This ticket was already used at check-in.";
      if (state === "Invalid") return "This ticket is invalid.";
      return `Not cancellable in the ${state} state.`;
    }
    if (!flight) return "Flight details unavailable.";
    if (flight.cancelled) return "This flight was cancelled.";
    if (flight.departed) return "This flight has already departed.";
    if (chainNow && Number(flight.refundDeadline) < chainNow) {
      return `Refund deadline passed (${UI.timestampText(flight.refundDeadline)}).`;
    }
    return null;
  }

  /// @notice Why "List for resale" is unavailable, or null when listing is allowed (DESIGN §3.4).
  function listBlockReason(t, flight) {
    const state = STATE_NAMES[Number(t.state)] || "Invalid";
    if (state === "Listed") return "This ticket is already listed for resale.";
    if (state !== "Issued") {
      return `A ${state} ticket cannot be resold.`;
    }
    if (platformPaused) return "The platform is paused — listing is disabled until it is unpaused.";
    if (!flight) return "Flight details unavailable.";
    if (flight.cancelled) return "This flight was cancelled — its tickets cannot be resold.";
    if (flight.departed) return "This flight has already departed — its tickets cannot be resold.";
    if (chainNow && Number(flight.refundDeadline) < chainNow) {
      return `Resale closed: refund deadline passed (${UI.timestampText(flight.refundDeadline)}).`;
    }
    if (chainNow && Number(flight.departureTime) - 2 * 3600 <= chainNow) {
      return "Check-in window reached — the listing window has closed.";
    }
    return null;
  }

  function ticketCardHtml(tokenId, t, flight, listing) {
    const stateLabel = STATE_NAMES[Number(t.state)] || "Invalid";
    const route = flight
      ? `${UI.escapeHtml(flight.origin)} → ${UI.escapeHtml(flight.destination)}`
      : "Route unavailable";
    const code = flight ? UI.escapeHtml(flight.flightCode) : "—";
    const blockReason = cancelBlockReason(t, flight);
    const listReason = listBlockReason(t, flight);
    const isListed = stateLabel === "Listed";
    const link = UI.verifyLink(tokenId);
    const qr = UI.qrDataUrl(new URL(link, window.location.href).href);

    return `
      <article class="ticket" data-token="${tokenId}">
        <div class="ticket-main">
          <div class="ticket-head">
            <span class="flight-code">#${tokenId} · ${code}</span>
            ${UI.statusBadge(stateLabel)}
          </div>
          <div class="ticket-route">${route}</div>
          <div class="ticket-rows">
            <div><span class="k">Departure</span>${flight ? UI.formatTimestamp(flight.departureTime) : "—"}</div>
            <div><span class="k">Issued</span>${UI.formatTimestamp(t.issuedAt)}</div>
            <div><span class="k">Owner</span><span class="mono">${UI.shortAddress(t.owner)}</span></div>
            <div><span class="k">Operator</span><span class="mono">${flight ? UI.shortAddress(flight.airline) : "—"}</span></div>
            ${
              isListed && listing
                ? `<div><span class="k">Asking price</span>${UI.ethFormat(listing.priceWei)}</div>` +
                  `<div><span class="k">Listing expires</span>${UI.formatTimestamp(listing.expiresAt)}</div>`
                : ""
            }
          </div>
          <div class="cid-line" data-cid-line>
            <span class="tick tick-warn" aria-hidden="true">·</span>
            <span>${UI.escapeHtml(t.metadataCID)}</span>
            ${UI.sourceBadge(t.metadataCID)}
            <span class="muted">verifying…</span>
          </div>
          <div class="ticket-actions">
            <button type="button" class="btn btn-sm btn-danger" data-action="cancel" data-token="${tokenId}"
              ${blockReason ? "disabled" : ""} title="${UI.escapeHtml(blockReason || "Cancel this ticket and claim the policy refund")}">Cancel &amp; refund</button>
            ${
              isListed
                ? `<button type="button" class="btn btn-sm" data-action="cancel-listing" data-token="${tokenId}"
                     title="Withdraw this listing — the ticket returns to Issued">Cancel listing</button>`
                : `<button type="button" class="btn btn-sm" data-action="list" data-token="${tokenId}"
                     ${listReason ? "disabled" : ""} title="${UI.escapeHtml(listReason || "Offer this ticket for resale on the marketplace")}">List for resale</button>`
            }
            <a class="btn btn-sm btn-ghost" href="${UI.escapeHtml(link)}">Verify publicly</a>
          </div>
          ${isListed ? '<div class="xsmall muted">Listed — a buyer can purchase this ticket from the Marketplace page.</div>' : ""}
          <div class="ticket-verify">
            ${
              qr
                ? `<a class="qr-thumb" href="${UI.escapeHtml(link)}" tabindex="-1" aria-hidden="true"><img src="${qr}" alt=""></a>`
                : ""
            }
            <span class="xsmall muted">Scan or open <a href="${UI.escapeHtml(link)}">verify.html?ticketId=${tokenId}</a> — anyone can check this ticket without a wallet.</span>
          </div>
        </div>
        <div class="ticket-stub">
          <span class="xsmall muted">Seat</span>
          <span class="seat">${UI.escapeHtml(t.seatReference)}</span>
          <div class="barcode" aria-hidden="true"></div>
          <span class="xsmall muted mono">Token #${tokenId}</span>
        </div>
      </article>`;
  }

  async function verifyCard(card, cid) {
    const line = card.querySelector("[data-cid-line]");
    if (!line) return;
    const result = await UI.verifyCid(cid);
    const label = line.querySelector(".muted");
    if (label) {
      label.className = `tick ${result.cls}`;
      label.textContent = result.text;
    }
    const dot = line.querySelector(".tick:not(.muted)");
    if (dot) {
      dot.className = `tick ${result.cls}`;
      dot.textContent = result.cls === "tick-ok" ? "✓" : result.cls === "tick-bad" ? "✕" : "·";
      dot.setAttribute("aria-hidden", "true");
    }
  }

  // ---- Cancellation: preview modal → transaction → result screen (FR-22, DESIGN §3.4) ----

  async function onCancelClick(btn) {
    if (submitting) return;
    const tokenId = Number(btn.dataset.token);
    const settlement = Wallet.read("TicketSettlement");
    const rec = ticketsCache.find((r) => r.id === tokenId);
    if (!rec) return;

    const blockReason = cancelBlockReason(rec.t, rec.flight);
    if (blockReason) {
      UI.toast("warn", blockReason);
      return;
    }

    // Authoritative preview straight from the contract — the modal must match its math.
    let preview;
    try {
      preview = await settlement.calculateRefund(tokenId);
    } catch (err) {
      UI.toast("error", UI.revertMessage(err, Wallet.allContracts()));
      return;
    }

    const confirmed = await UI.confirmModal({
      title: `Cancel ticket #${tokenId}?`,
      body: `
        <dl class="kv">
          <dt>Fare paid</dt><dd>${UI.ethFormat(rec.flight.priceWei)}</dd>
          <dt>Refund back to you</dt><dd><strong>${UI.ethFormat(preview.refund)}</strong></dd>
          <dt>Airline retains</dt><dd>${UI.ethFormat(preview.retained)}</dd>
          <dt>Refund deadline</dt><dd>${UI.formatTimestamp(rec.flight.refundDeadline)}</dd>
        </dl>
        <p class="xsmall muted mb-0">
          One transaction closes the ticket as <strong>Cancelled</strong>, returns the seat to inventory,
          and pays the refund to your wallet. The ticket can never be used or resold afterwards.
        </p>`,
      confirmText: "Cancel & request refund",
      danger: true,
    });
    if (!confirmed) return;
    if (!(await Wallet.requireWrite())) return;

    submitting = true;
    UI.setBusy(btn, true);
    progressEl.hidden = false;
    resultEl.hidden = true;
    resultEl.innerHTML = "";
    const steps = UI.txSteps(progressEl, [
      "Re-check refund preview",
      "Send cancellation transaction",
      "Confirm refund on chain",
    ]);

    try {
      steps.set(0, "active");
      preview = await settlement.calculateRefund(tokenId);
      steps.set(0, "done");

      steps.set(1, "active");
      const write = await Wallet.write("TicketSettlement");
      const tx = await write.cancel(tokenId);
      steps.set(1, "done");

      steps.set(2, "active");
      const receipt = await tx.wait();
      if (receipt.status !== 1) throw new Error("transaction reverted");
      steps.set(2, "done");

      // Refund figures come from the emitted event; the hash from the wallet receipt (D-16).
      let refund = preview.refund;
      let retained = preview.retained;
      for (const log of receipt.logs) {
        try {
          const parsed = settlement.interface.parseLog(log);
          if (parsed && parsed.name === "TicketRefunded") {
            refund = parsed.args.refund;
            retained = parsed.args.retained;
          }
        } catch {
          /* log from another contract */
        }
      }

      renderCancelResult({ tokenId, refund, retained, hash: receipt.hash });
      UI.toast("success", `Ticket #${tokenId} cancelled.`, receipt.hash);
      await load();
      resultEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (err) {
      console.error("cancel failed", err);
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

  function renderCancelResult({ tokenId, refund, retained, hash }) {
    resultEl.hidden = false;
    resultEl.innerHTML = `
      <section class="notice notice-success" aria-live="polite">
        <div class="row">
          <strong>Ticket #${tokenId} cancelled.</strong>
          ${UI.statusBadge("Cancelled")}
        </div>
        <dl class="kv mt-3">
          <dt>Refund paid to you</dt><dd>${UI.ethFormat(refund)}</dd>
          <dt>Airline retains</dt><dd>${UI.ethFormat(retained)}</dd>
          <dt>Transaction hash</dt><dd class="mono xsmall">${UI.escapeHtml(hash)}</dd>
        </dl>
        <div class="btn-row row mt-3">
          <a class="btn btn-primary btn-sm" href="${UI.escapeHtml(UI.verifyLink(tokenId))}">Verify publicly</a>
          <button type="button" class="btn btn-sm" id="dismiss-result">Dismiss</button>
        </div>
      </section>`;
    const dismiss = document.getElementById("dismiss-result");
    if (dismiss) dismiss.addEventListener("click", () => (resultEl.hidden = true));
  }

  // ---- Resale listing: preview modal → transaction → result (FR-27/28/30, DESIGN §3.4) ----

  /// @notice Display-only split mirroring the marketplace rounding rule (royalty floors).
  function splitFor(priceEth, royaltyBps) {
    try {
      const wei = window.ethers.parseEther(String(priceEth || "0"));
      if (wei <= 0n) return null;
      const royalty = (wei * BigInt(royaltyBps)) / 10000n;
      return { wei, royalty, proceeds: wei - royalty };
    } catch {
      return null;
    }
  }

  async function onListClick(btn) {
    if (submitting) return;
    const tokenId = Number(btn.dataset.token);
    const rec = ticketsCache.find((r) => r.id === tokenId);
    if (!rec) return;

    const blockReason = listBlockReason(rec.t, rec.flight);
    if (blockReason) {
      UI.toast("warn", blockReason);
      return;
    }

    let preview;
    try {
      const marketplace = Wallet.read("TicketMarketplace");
      preview = await marketplace.previewResale(tokenId, 0n);
    } catch (err) {
      UI.toast("error", UI.revertMessage(err, Wallet.allContracts()));
      return;
    }

    const defaultExpiry = Number(preview.defaultExpiry);
    if (defaultExpiry <= chainNow) {
      UI.toast("warn", "The listing window for this ticket has already closed.");
      return;
    }

    const royaltyBps = Number(preview.royaltyBps);
    const royaltyPct = (royaltyBps / 100).toFixed(1).replace(/\.0$/, "");
    const form = {
      priceEth: UI.ethText(preview.originalPriceWei),
      expiresAt: defaultExpiry,
    };

    const modalPromise = UI.confirmModal({
      title: `List ticket #${tokenId} for resale`,
      body: `
        <div class="field">
          <label for="list-price">Asking price (ETH)</label>
          <input type="number" id="list-price" min="0" step="0.0001"
            value="${UI.escapeHtml(form.priceEth)}" autocomplete="off">
          <span class="hint">Original fare ${UI.ethFormat(preview.originalPriceWei)} ·
            maximum ${UI.ethFormat(preview.maxPriceWei)} (120% of the fare).</span>
        </div>
        <div class="field">
          <label for="list-expires">Listing expires</label>
          <input type="datetime-local" id="list-expires"
            value="${UI.escapeHtml(UI.unixToLocalInput(defaultExpiry))}">
          <span class="hint">Defaults to 24 hours from now; never later than
            ${UI.formatTimestamp(preview.checkinBound)} (2 hours before departure).</span>
        </div>
        <dl class="kv" id="list-split">
          <dt>Airline royalty (${royaltyPct}%)</dt><dd data-split="royalty">—</dd>
          <dt>You receive</dt><dd data-split="proceeds">—</dd>
          <dt>Buyer pays</dt><dd data-split="total">—</dd>
        </dl>
        <p class="xsmall muted mb-0" id="list-hint">
          The ticket moves to <strong>Listed</strong>: it can no longer be cancelled or transferred
          directly. Withdraw the listing at any time from this page.
        </p>`,
      confirmText: "Publish listing",
    });

    // confirmModal appends its backdrop synchronously, so the inputs are addressable now.
    const backdrop = document.querySelector(".modal-backdrop");
    const okBtn = backdrop ? backdrop.querySelector('[data-role="ok"]') : null;
    const priceInput = backdrop ? backdrop.querySelector("#list-price") : null;
    const expiryInput = backdrop ? backdrop.querySelector("#list-expires") : null;
    const hint = backdrop ? backdrop.querySelector("#list-hint") : null;

    function refreshModal() {
      const split = splitFor(form.priceEth, royaltyBps);
      let problem = "";
      if (!split) {
        problem = "Enter a resale price greater than zero.";
      } else if (split.wei > preview.maxPriceWei) {
        problem = `The asking price may not exceed ${UI.ethText(preview.maxPriceWei)} ETH (120% of the fare).`;
      } else if (form.expiresAt <= chainNow) {
        problem = "The listing expiry must be in the future.";
      } else if (form.expiresAt > Number(preview.checkinBound)) {
        problem = "The listing must expire at least 2 hours before departure.";
      }
      if (backdrop) {
        const out = (k) => backdrop.querySelector(`[data-split="${k}"]`);
        if (out("royalty")) out("royalty").innerHTML = split ? UI.ethFormat(split.royalty) : "—";
        if (out("proceeds")) out("proceeds").innerHTML = split ? UI.ethFormat(split.proceeds) : "—";
        if (out("total")) out("total").innerHTML = split ? UI.ethFormat(split.wei) : "—";
      }
      if (hint) {
        hint.textContent = problem
          ? problem
          : "The ticket moves to Listed: it can no longer be cancelled or transferred directly. Withdraw the listing at any time from this page.";
        hint.className = problem ? "xsmall text-danger mb-0" : "xsmall muted mb-0";
      }
      if (okBtn) okBtn.disabled = Boolean(problem);
    }

    if (priceInput) {
      priceInput.addEventListener("input", () => {
        form.priceEth = priceInput.value;
        refreshModal();
      });
    }
    if (expiryInput) {
      expiryInput.addEventListener("change", () => {
        form.expiresAt = UI.localInputToUnix(expiryInput.value);
        refreshModal();
      });
    }
    refreshModal();

    const confirmed = await modalPromise;
    if (!confirmed) return;
    const split = splitFor(form.priceEth, royaltyBps);
    if (!split || split.wei > preview.maxPriceWei) {
      UI.toast("error", "Enter a valid asking price before publishing.");
      return;
    }
    if (!(await Wallet.requireWrite())) return;

    submitting = true;
    UI.setBusy(btn, true);
    progressEl.hidden = false;
    resultEl.hidden = true;
    resultEl.innerHTML = "";
    const steps = UI.txSteps(progressEl, [
      "Validate price and expiry",
      "Send listing transaction",
      "Confirm Listed state on chain",
    ]);

    try {
      steps.set(0, "active");
      steps.set(0, "done");

      steps.set(1, "active");
      const write = await Wallet.write("TicketMarketplace");
      const tx = await write.list(tokenId, split.wei, form.expiresAt);
      steps.set(1, "done");

      steps.set(2, "active");
      const receipt = await tx.wait();
      if (receipt.status !== 1) throw new Error("transaction reverted");
      steps.set(2, "done");

      let created = { listingId: 0n, priceWei: split.wei, expiresAt: BigInt(form.expiresAt) };
      for (const log of receipt.logs) {
        try {
          const parsed = write.interface.parseLog(log);
          if (parsed && parsed.name === "ListingCreated") created = parsed.args;
        } catch {
          /* log from another contract */
        }
      }

      renderListingResult({
        tokenId,
        listingId: Number(created.listingId),
        priceWei: created.priceWei,
        expiresAt: created.expiresAt,
        royalty: split.royalty,
        proceeds: split.proceeds,
        hash: receipt.hash,
      });
      UI.toast("success", `Ticket #${tokenId} listed for resale.`, receipt.hash);
      await load();
      resultEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (err) {
      console.error("list failed", err);
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

  async function onCancelListingClick(btn) {
    if (submitting) return;
    const tokenId = Number(btn.dataset.token);
    const rec = ticketsCache.find((r) => r.id === tokenId);
    if (!rec || !rec.listing) {
      UI.toast("warn", "No active listing was found for this ticket.");
      return;
    }
    const listing = rec.listing;

    const confirmed = await UI.confirmModal({
      title: `Withdraw listing #${Number(listing.listingId)}?`,
      body: `
        <dl class="kv">
          <dt>Ticket</dt><dd>#${tokenId}</dd>
          <dt>Asking price</dt><dd>${UI.ethFormat(listing.priceWei)}</dd>
          <dt>Expires</dt><dd>${UI.formatTimestamp(listing.expiresAt)}</dd>
        </dl>
        <p class="xsmall muted mb-0">
          The ticket returns to <strong>Issued</strong>, so you can cancel it, keep it, or list it
          again. This works even while the platform is paused — withdrawing is always allowed.
        </p>`,
      confirmText: "Withdraw listing",
      danger: true,
    });
    if (!confirmed) return;
    if (!(await Wallet.requireWrite())) return;

    submitting = true;
    UI.setBusy(btn, true);
    progressEl.hidden = false;
    resultEl.hidden = true;
    resultEl.innerHTML = "";
    const steps = UI.txSteps(progressEl, [
      "Read the active listing",
      "Send withdrawal transaction",
      "Confirm ticket is Issued again",
    ]);

    try {
      steps.set(0, "active");
      steps.set(0, "done");

      steps.set(1, "active");
      const write = await Wallet.write("TicketMarketplace");
      const tx = await write.cancelListing(Number(listing.listingId));
      steps.set(1, "done");

      steps.set(2, "active");
      const receipt = await tx.wait();
      if (receipt.status !== 1) throw new Error("transaction reverted");
      steps.set(2, "done");

      renderListingResult({
        tokenId,
        listingId: Number(listing.listingId),
        withdrawn: true,
        hash: receipt.hash,
      });
      UI.toast("success", `Listing for ticket #${tokenId} withdrawn.`, receipt.hash);
      await load();
      resultEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (err) {
      console.error("cancel listing failed", err);
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

  function renderListingResult(data) {
    resultEl.hidden = false;
    const withdrawn = Boolean(data.withdrawn);
    resultEl.innerHTML = `
      <section class="notice ${withdrawn ? "notice-info" : "notice-success"}" aria-live="polite">
        <div class="row">
          <strong>
            ${withdrawn ? `Listing #${data.listingId} withdrawn.` : `Ticket #${data.tokenId} is now listed.`}
          </strong>
          ${UI.statusBadge(withdrawn ? "Issued" : "Listed")}
        </div>
        <dl class="kv mt-3">
          ${
            withdrawn
              ? `<dt>Ticket</dt><dd>#${data.tokenId} is available again</dd>`
              : `<dt>Asking price</dt><dd>${UI.ethFormat(data.priceWei)}</dd>
                 <dt>Airline royalty at sale</dt><dd>${UI.ethFormat(data.royalty)}</dd>
                 <dt>You would receive</dt><dd>${UI.ethFormat(data.proceeds)}</dd>
                 <dt>Expires</dt><dd>${UI.formatTimestamp(data.expiresAt)}</dd>`
          }
          <dt>Transaction hash</dt><dd class="mono xsmall">${UI.escapeHtml(data.hash)}</dd>
        </dl>
        <div class="btn-row row mt-3">
          ${
            withdrawn
              ? ""
              : '<a class="btn btn-primary btn-sm" href="marketplace.html">View on marketplace</a>'
          }
          <button type="button" class="btn btn-sm" id="dismiss-result">Dismiss</button>
        </div>
      </section>`;
    const dismiss = document.getElementById("dismiss-result");
    if (dismiss) dismiss.addEventListener("click", () => (resultEl.hidden = true));
  }

  // ---- Transaction history (booking / cancellation / refund) with type filter ----

  function historyTypeLabel(type) {
    if (type === "booking") return '<span class="badge badge-issued">Booked</span>';
    if (type === "cancel") return '<span class="badge badge-cancelled">Cancelled</span>';
    if (type === "refund") return '<span class="badge badge-info">Refund</span>';
    if (type === "listing") return '<span class="badge badge-listed">Listed</span>';
    if (type === "sold") return '<span class="badge badge-ok">Resale sold</span>';
    if (type === "resale") return '<span class="badge badge-info">Resale bought</span>';
    return '<span class="badge badge-idle">Event</span>';
  }

  // One filter option can cover more than one underlying event type (listings vs. resales).
  const HISTORY_GROUPS = {
    all: null,
    booking: ["booking"],
    cancel: ["cancel"],
    refund: ["refund"],
    listing: ["listing"],
    sale: ["sold", "resale"],
  };

  function renderHistory() {
    const filter = historyFilter ? historyFilter.value : "all";
    const allowed = HISTORY_GROUPS[filter] ?? null;
    const rows = historyRows.filter((r) => !allowed || allowed.includes(r.type));
    historyBody.innerHTML = UI.txHistoryRows(
      rows,
      historyRows.length === 0
        ? "No wallet activity yet."
        : "No entries of this type yet.",
      4
    );
    const count = document.getElementById("history-count");
    if (count) count.textContent = `${rows.length} entr${rows.length === 1 ? "y" : "ies"}`;
  }

  async function loadHistory(address, ownedIds) {
    if (Wallet.configMissing()) return;
    const settlement = Wallet.read("TicketSettlement");
    const marketplace = Wallet.read("TicketMarketplace");
    const [purchases, cancels, refunds, created, sold, withdrawn] = await Promise.all([
      settlement.queryFilter(settlement.filters.PurchaseCompleted(null, null, address)).catch(() => []),
      settlement.queryFilter(settlement.filters.TicketCancelled(null, address)).catch(() => []),
      settlement.queryFilter(settlement.filters.TicketRefunded()).catch(() => []),
      marketplace.queryFilter(marketplace.filters.ListingCreated(null, null, address)).catch(() => []),
      marketplace.queryFilter(marketplace.filters.ListingSold()).catch(() => []),
      marketplace.queryFilter(marketplace.filters.ListingCancelled()).catch(() => []),
    ]);

    // ListingCancelled / ListingSold omit the seller, so resolve the closed listing records.
    const closedIds = [...new Set([...sold, ...withdrawn].map((e) => Number(e.args.listingId)))];
    const closed = new Map();
    await Promise.all(
      closedIds.map(async (id) => {
        try {
          closed.set(id, await marketplace.getListing(id));
        } catch {
          /* listing record unavailable */
        }
      })
    );
    const sellerOf = (id) => (closed.get(id)?.seller || "").toLowerCase();
    const isMine = (id) => sellerOf(id) === address.toLowerCase();

    const owned = new Set(ownedIds);
    const events = [
      ...purchases.map((e) => ({
        type: "booking",
        blockNumber: e.blockNumber,
        hash: e.transactionHash,
        details:
          `Flight #${Number(e.args.flightId)} · ticket #${Number(e.args.tokenId)} ` +
          `${UI.sourceBadge(e.args.cid)}`,
      })),
      ...cancels.map((e) => ({
        type: "cancel",
        blockNumber: e.blockNumber,
        hash: e.transactionHash,
        details: `Ticket #${Number(e.args.tokenId)} closed as <strong>Cancelled</strong>`,
      })),
      ...refunds
        .filter((e) => owned.has(Number(e.args.tokenId)))
        .map((e) => ({
          type: "refund",
          blockNumber: e.blockNumber,
          hash: e.transactionHash,
          details:
            `Ticket #${Number(e.args.tokenId)} · refund ${UI.ethFormat(e.args.refund)} ` +
            `· retained ${UI.ethFormat(e.args.retained)}`,
        })),
      ...created.map((e) => ({
        type: "listing",
        blockNumber: e.blockNumber,
        hash: e.transactionHash,
        details:
          `Ticket #${Number(e.args.tokenId)} listed for ${UI.ethFormat(e.args.priceWei)} ` +
          `· expires ${UI.formatTimestamp(e.args.expiresAt)}`,
      })),
      ...withdrawn
        .filter((e) => isMine(Number(e.args.listingId)))
        .map((e) => ({
          type: "listing",
          blockNumber: e.blockNumber,
          hash: e.transactionHash,
          details: `Listing #${Number(e.args.listingId)} withdrawn before a sale`,
        })),
      ...sold
        .filter((e) => isMine(Number(e.args.listingId)))
        .map((e) => ({
          type: "sold",
          blockNumber: e.blockNumber,
          hash: e.transactionHash,
          details:
            `Ticket #${Number(e.args.tokenId)} sold for ${UI.ethFormat(e.args.priceWei)} ` +
            `· royalty ${UI.ethFormat(e.args.royalty)} · you received ${UI.ethFormat(e.args.sellerProceeds)}`,
        })),
      ...sold
        .filter((e) => (e.args.buyer || "").toLowerCase() === address.toLowerCase())
        .map((e) => ({
          type: "resale",
          blockNumber: e.blockNumber,
          hash: e.transactionHash,
          details:
            `Ticket #${Number(e.args.tokenId)} bought for ${UI.ethFormat(e.args.priceWei)} ` +
            `· airline royalty included ${UI.ethFormat(e.args.royalty)}`,
        })),
    ];

    if (events.length === 0) {
      historyRows = [];
      renderHistory();
      return;
    }

    const blockNumbers = [...new Set(events.map((e) => e.blockNumber))];
    const blocks = await Promise.all(
      blockNumbers.map((bn) => settlement.runner.provider.getBlock(bn).catch(() => null))
    );
    const timeByBlock = new Map(
      blockNumbers.map((bn, i) => [bn, blocks[i] ? blocks[i].timestamp : null])
    );

    historyRows = events
      .sort((a, b) => b.blockNumber - a.blockNumber)
      .map((e) => ({
        type: e.type,
        hash: e.hash,
        details: e.details,
        badge: historyTypeLabel(e.type),
        time: timeByBlock.get(e.blockNumber)
          ? UI.formatTimestamp(timeByBlock.get(e.blockNumber))
          : `block ${e.blockNumber}`,
      }));
    renderHistory();
  }

  // ---- Load ----

  async function load() {
    if (loading) return;
    loading = true;
    try {
      await Wallet.ready;
      if (Wallet.configMissing()) {
        setNotice(
          '<div class="notice notice-danger"><strong>Contract configuration missing.</strong> ' +
            "Run <code>npm run deploy</code>, then reload.</div>"
        );
        resultCount.textContent = "";
        return;
      }
      if (!Wallet.hasInjectedWallet()) {
        setNotice(
          '<div class="notice notice-warn"><strong>No wallet detected.</strong> ' +
            "Install MetaMask (or a compatible wallet) to hold and verify tickets.</div>"
        );
        return;
      }
      if (!Wallet.state.address) {
        setNotice(
          '<div class="notice"><strong>Wallet not connected.</strong> ' +
            'Connect to see the tickets held by your address. <button type="button" class="btn btn-primary btn-sm" id="inline-connect">Connect wallet</button></div>'
        );
        const inline = document.getElementById("inline-connect");
        if (inline) inline.addEventListener("click", () => Wallet.connect());
        return;
      }
      if (!Wallet.isSupportedChain()) {
        setNotice(
          '<div class="notice notice-warn"><strong>Wrong network.</strong> ' +
            `Switch to Hardhat chain ${Wallet.expectedChainId()} to load your tickets. ` +
            '<button type="button" class="btn btn-sm" id="inline-switch">Switch network</button></div>'
        );
        const sw = document.getElementById("inline-switch");
        if (sw) sw.addEventListener("click", () => Wallet.ensureChain());
        return;
      }

      setNotice("");
      const address = Wallet.state.address;
      const nft = Wallet.read("AirTicketNFT");
      const inventory = Wallet.read("FlightInventory");
      const registry = Wallet.read("AirlineRegistry");
      const marketplace = Wallet.read("TicketMarketplace");

      // Listing reverts on either pause source (`TicketMarketplace.whenPlatformLive`), so
      // both must be read; withdrawing a listing is exempt and stays available either way.
      platformPaused =
        (await registry.paused().catch(() => false)) ||
        (await marketplace.paused().catch(() => false));
      if (platformPaused) {
        setNotice(
          '<div class="notice notice-warn"><strong>Platform paused.</strong> ' +
            "Listing and resale are disabled; cancelling a ticket stays available.</div>"
        );
      }

      const latestBlock = await nft.runner.provider.getBlock("latest");
      chainNow = latestBlock ? Number(latestBlock.timestamp) : Math.floor(Date.now() / 1000);

      const nextId = Number(await nft.nextTokenId());
      const tickets = [];
      for (let id = 1; id < nextId; id += 1) {
        try {
          const t = await nft.getTicket(id);
          if (t.owner.toLowerCase() === address.toLowerCase()) {
            tickets.push({ id, t, flight: null, listing: null });
          }
        } catch {
          /* ticket id not minted */
        }
      }

      // Active resale listing for any ticket the wallet still owns.
      await Promise.all(
        tickets
          .filter((r) => Number(r.t.state) === 1)
          .map(async (r) => {
            try {
              const listingId = Number(await marketplace.activeListingByToken(r.id));
              if (listingId > 0) r.listing = await marketplace.getListing(listingId);
            } catch {
              /* no listing / marketplace unavailable */
            }
          })
      );

      const flightIds = [...new Set(tickets.map((r) => Number(r.t.flightId)))];
      const flights = new Map();
      await Promise.all(
        flightIds.map((id) =>
          inventory.getFlight(id).then(
            (f) => flights.set(id, f),
            () => flights.set(id, null)
          )
        )
      );
      tickets.forEach((r) => {
        r.flight = flights.get(Number(r.t.flightId)) || null;
      });
      ticketsCache = tickets;

      const active = tickets.filter((r) => ACTIVE_STATES.has(STATE_NAMES[Number(r.t.state)]));
      const past = tickets.filter((r) => !active.includes(r));

      resultCount.textContent = `${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`;

      if (tickets.length === 0) {
        activeList.innerHTML =
          '<div class="notice empty-state" style="grid-column:1/-1">No tickets in this wallet yet. ' +
          '<a href="flights.html">Browse flights</a> to book your first seat.</div>';
        pastList.innerHTML = "";
        // History still matters here: a wallet that sold or cancelled its last ticket owns
        // nothing but must keep seeing its booking / listing / resale activity.
        await loadHistory(address, []);
        return;
      }

      activeList.innerHTML =
        active.length > 0
          ? active.map((r) => ticketCardHtml(r.id, r.t, r.flight, r.listing)).join("")
          : '<div class="notice empty-state" style="grid-column:1/-1">No active tickets.</div>';
      pastList.innerHTML =
        past.length > 0
          ? past.map((r) => ticketCardHtml(r.id, r.t, r.flight, r.listing)).join("")
          : '<div class="notice empty-state" style="grid-column:1/-1">No past tickets.</div>';

      // Verify each ticket's CID (network-dependent; runs after paint).
      document.querySelectorAll(".ticket[data-token]").forEach((card) => {
        const id = Number(card.dataset.token);
        const rec = tickets.find((x) => x.id === id);
        if (rec) verifyCard(card, rec.t.metadataCID);
      });
      UI.bindPendingLinks(document);

      await loadHistory(
        address,
        tickets.map((r) => r.id)
      );
    } catch (err) {
      console.error(err);
      setNotice(
        '<div class="notice notice-danger"><strong>Could not load tickets.</strong> ' +
          UI.escapeHtml(UI.revertMessage(err, Wallet.allContracts())) +
          " Is the Hardhat node running?</div>"
      );
    } finally {
      loading = false;
    }
  }

  // ---- Wiring ----

  [activeList, pastList].forEach((list) =>
    list.addEventListener("click", (e) => {
      const cancelBtn = e.target.closest('[data-action="cancel"]');
      if (cancelBtn && !cancelBtn.disabled) {
        onCancelClick(cancelBtn);
        return;
      }
      const listBtn = e.target.closest('[data-action="list"]');
      if (listBtn && !listBtn.disabled) {
        onListClick(listBtn);
        return;
      }
      const withdrawBtn = e.target.closest('[data-action="cancel-listing"]');
      if (withdrawBtn && !withdrawBtn.disabled) onCancelListingClick(withdrawBtn);
    })
  );
  if (historyFilter) historyFilter.addEventListener("change", renderHistory);

  let reloadTimer = null;
  Wallet.onChange((s) => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 150);
    if (s.address) setNotice("");
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", load);
  } else {
    load();
  }
})();
