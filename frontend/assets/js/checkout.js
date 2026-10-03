// checkout.html — one-seat purchase: metadata upload (or mock fallback) + settlement.purchase.
// Atomicity note (PRD FR-12): a failed transaction mints nothing; an IPFS CID uploaded just
// before a revert is harmless orphaned metadata and is reported to the user.
(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const flightId = Number(params.get("flight"));

  const notices = document.getElementById("page-notices");
  const summaryEl = document.getElementById("flight-summary");
  const stateEl = document.getElementById("flight-state");
  const paymentEl = document.getElementById("payment-summary");
  const metaEl = document.getElementById("metadata-preview");
  const credCheck = document.getElementById("cred-check");
  const disclosure = document.getElementById("disclosure");
  const confirmBtn = document.getElementById("confirm-btn");
  const hintEl = document.getElementById("confirm-hint");
  const progressEl = document.getElementById("tx-progress");
  const successPanel = document.getElementById("success-panel");

  let flight = null;
  let platformPaused = false;
  let nextSeat = "—";
  let submitting = false;
  let done = false;

  function setNotice(html) {
    notices.innerHTML = html || "";
  }

  function bookable() {
    if (!flight || done) return false;
    if (flight.cancelled || flight.departed || !flight.salesOpen) return false;
    if (Number(flight.seatsAvailable) === 0) return false;
    if (platformPaused) return false;
    return true;
  }

  function refundPreview() {
    const price = BigInt(flight.priceWei);
    const refund = (price * BigInt(flight.refundBps)) / 10000n;
    return { refund, retained: price - refund };
  }

  function buildMetadata() {
    return {
      fictional: true,
      flightCode: String(flight.flightCode),
      origin: String(flight.origin),
      destination: String(flight.destination),
      departureTime: Number(flight.departureTime),
      priceWei: String(flight.priceWei),
      refundBps: Number(flight.refundBps),
      refundDeadline: Number(flight.refundDeadline),
      travelerWallet: Wallet.state.address || "not-connected",
    };
  }

  function buildBody() {
    const meta = buildMetadata();
    meta.fingerprint = UI.fingerprint(JSON.stringify(meta));
    return JSON.stringify(meta);
  }

  function renderMetadataPreview() {
    if (!flight) return;
    const body = buildBody();
    const parsed = JSON.parse(body);
    const rows = [
      ["Fictional sample", "yes — no real passenger data"],
      ["Flight", `${parsed.flightCode} · ${parsed.origin} → ${parsed.destination}`],
      ["Departure", UI.timestampText(parsed.departureTime)],
      ["Price (wei)", parsed.priceWei],
      ["Refund policy", `${(parsed.refundBps / 100).toFixed(0)}% until ${UI.timestampText(parsed.refundDeadline)}`],
      ["Traveler wallet", parsed.travelerWallet],
      ["Fingerprint (FNV-1a 64)", parsed.fingerprint],
    ];
    metaEl.innerHTML = rows
      .map(([k, v]) => `<dt>${UI.escapeHtml(k)}</dt><dd class="mono">${UI.escapeHtml(v)}</dd>`)
      .join("");
  }

  async function load() {
    if (Wallet.configMissing()) {
      setNotice(
        '<div class="notice notice-danger"><strong>Contract configuration missing.</strong> ' +
          "Run <code>npm run deploy</code>, then reload.</div>"
      );
      confirmBtn.disabled = true;
      hintEl.textContent = "Contract configuration missing.";
      return;
    }
    if (!flightId) {
      setNotice(
        '<div class="notice notice-warn"><strong>No flight selected.</strong> ' +
          '<a href="flights.html">Browse flights</a> and pick a seat.</div>'
      );
      confirmBtn.disabled = true;
      hintEl.textContent = "No flight selected.";
      return;
    }
    try {
      const inventory = Wallet.read("FlightInventory");
      const registry = Wallet.read("AirlineRegistry");
      const settlement = Wallet.read("TicketSettlement");

      // Mirrors `whenPlatformLive`: settlement reverts on `paused() || registry.paused()`.
      [flight, platformPaused] = await Promise.all([
        inventory.getFlight(flightId).catch(() => null),
        Promise.all([
          registry.paused().catch(() => false),
          settlement.paused().catch(() => false),
        ]).then(([r, s]) => r || s),
      ]);
      if (!flight) {
        setNotice(
          '<div class="notice notice-danger"><strong>Unknown flight.</strong> ' +
            'That flight id does not exist. <a href="flights.html">Back to flights</a></div>'
        );
        confirmBtn.disabled = true;
        hintEl.textContent = "Unknown flight.";
        return;
      }
      nextSeat = await settlement.previewSeatReference(flightId).catch(() => "—");

      if (platformPaused) {
        setNotice(
          '<div class="notice notice-warn"><strong>Platform paused.</strong> ' +
            "Booking is disabled until the administrator unpauses the platform.</div>"
        );
      } else if (flight.cancelled) {
        setNotice('<div class="notice notice-danger"><strong>This flight was cancelled.</strong></div>');
      } else if (flight.departed) {
        setNotice('<div class="notice notice-danger"><strong>This flight has already departed.</strong></div>');
      } else if (!flight.salesOpen) {
        setNotice('<div class="notice notice-warn"><strong>Sales are closed</strong> for this flight (draft or paused).</div>');
      } else if (Number(flight.seatsAvailable) === 0) {
        setNotice('<div class="notice notice-warn"><strong>Sold out.</strong> No seats remain on this flight.</div>');
      }

      renderSummary();
      renderPayment();
      renderMetadataPreview();
      updateButton();
    } catch (err) {
      console.error(err);
      setNotice(
        '<div class="notice notice-danger"><strong>Could not load this flight.</strong> ' +
          UI.escapeHtml(UI.revertMessage(err, Wallet.allContracts())) +
          " Is the Hardhat node running?</div>"
      );
      confirmBtn.disabled = true;
      hintEl.textContent = "Failed to load flight.";
    }
  }

  function renderSummary() {
    const badge = UI.flightBadge(flight, flight.salesOpen || flight.departed || flight.cancelled);
    stateEl.innerHTML = badge;
    const sold = Number(flight.seatCapacity) - Number(flight.seatsAvailable);
    summaryEl.innerHTML = `
      <div class="flight-head">
        <span class="flight-code">${UI.escapeHtml(flight.flightCode)}</span>
        <span class="xsmall muted">Operator <span class="mono">${UI.shortAddress(flight.airline)}</span></span>
      </div>
      <div class="route">${UI.escapeHtml(flight.origin)}
        <span class="arrow" aria-hidden="true">→</span>
        <span class="sr-only">to</span>${UI.escapeHtml(flight.destination)}</div>
      <dl class="kv mt-3">
        <dt>Departure</dt><dd>${UI.formatTimestamp(flight.departureTime)}</dd>
        <dt>Next seat</dt><dd class="mono">${UI.escapeHtml(nextSeat)}</dd>
        <dt>Seats</dt><dd>${sold} of ${Number(flight.seatCapacity)} booked · ${Number(flight.seatsAvailable)} available</dd>
        <dt>Seat class</dt><dd>Economy (sample data)</dd>
      </dl>`;
  }

  function renderPayment() {
    const { refund, retained } = refundPreview();
    const refundPct = (Number(flight.refundBps) / 100).toFixed(0);
    paymentEl.innerHTML = `
      <dl class="kv">
        <dt>Total due now</dt><dd class="price">${UI.ethFormat(flight.priceWei)}</dd>
        <dt>Refund if cancelled</dt><dd>${UI.ethFormat(refund)} <span class="muted">(${refundPct}% policy)</span></dd>
        <dt>Airline retains</dt><dd>${UI.ethFormat(retained)}</dd>
        <dt>Refund deadline</dt><dd>${UI.formatTimestamp(flight.refundDeadline)}</dd>
        <dt>Payment token</dt><dd>Test ETH (native)</dd>
      </dl>
      <p class="xsmall muted mt-3 mb-0">
        One transaction reserves ${UI.escapeHtml(nextSeat)}, mints the ticket NFT, and records the
        metadata CID. Exact payment is required — the contract rejects over/underpayment.
      </p>`;
  }

  function updateButton() {
    if (submitting) return;
    if (done) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Booked";
      hintEl.textContent = "This booking is complete. Browse more flights to book another.";
      return;
    }
    if (!flight) return;

    const bothChecked = credCheck.checked && disclosure.checked;

    if (!bookable()) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Confirm & pay";
      hintEl.textContent = platformPaused
        ? "Platform paused — booking disabled."
        : flight.cancelled
          ? "Flight cancelled."
          : flight.departed
            ? "Flight departed."
            : !flight.salesOpen
              ? "Sales closed for this flight."
              : "Sold out.";
      return;
    }
    if (!bothChecked) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Confirm & pay";
      hintEl.textContent = "Confirm both statements above to continue.";
      return;
    }

    confirmBtn.disabled = false;
    if (!Wallet.state.address) {
      confirmBtn.textContent = "Connect wallet & confirm";
      hintEl.textContent = "You will connect your wallet, then approve the payment.";
    } else if (!Wallet.isSupportedChain()) {
      confirmBtn.textContent = "Switch network & confirm";
      hintEl.textContent = `Your wallet must be on Hardhat chain ${Wallet.expectedChainId()}.`;
    } else {
      confirmBtn.textContent = `Confirm & pay ${UI.ethText(flight.priceWei)} ETH`;
      hintEl.textContent = "Your wallet will ask you to sign one purchase transaction.";
    }
  }

  async function uploadMetadata(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), APP_CONFIG.uploadTimeoutMs);
    try {
      const res = await fetch(APP_CONFIG.uploadEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The endpoint takes the metadata document itself (upload.js POST contract);
        // the { name, content } shape is only the server-to-provider envelope.
        body,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`upload endpoint responded ${res.status}`);
      const data = await res.json();
      const cid = data.cid || data.hash || data.IpfsHash;
      if (typeof cid !== "string" || !/^[A-Za-z0-9]{8,128}$/.test(cid)) {
        throw new Error("upload endpoint returned an unusable CID");
      }
      return cid;
    } finally {
      clearTimeout(timer);
    }
  }

  async function onConfirm() {
    if (submitting || done) return;
    if (!bookable() || !(credCheck.checked && disclosure.checked)) return;
    if (!(await Wallet.requireWrite())) return;

    submitting = true;
    confirmBtn.disabled = true;
    progressEl.hidden = false;
    const steps = UI.txSteps(progressEl, [
      "Upload ticket metadata (IPFS)",
      "Send purchase transaction",
      "Confirm on chain & mint ticket",
    ]);

    let cid = null;
    let uploadedIpfs = false;

    try {
      // Balance pre-check for a friendlier error than the node's.
      const balance = await Wallet.state.provider.getBalance(Wallet.state.address);
      if (balance < BigInt(flight.priceWei)) {
        throw Object.assign(new Error("insufficient funds for this purchase"), { shortMessage: "insufficient funds" });
      }

      // Step 1: metadata upload (protected endpoint) → deterministic mock fallback (D-05).
      steps.set(0, "active");
      const body = buildBody();
      try {
        cid = await uploadMetadata(body);
        uploadedIpfs = true;
      } catch (uploadErr) {
        console.warn("upload failed, using mock CID", uploadErr);
        cid = UI.mockCidFor(body);
        UI.toast(
          "warn",
          "Upload endpoint unreachable — recorded a local mock CID instead. Ticket metadata stays on this device."
        );
      }
      if (!/^[A-Za-z0-9]{8,128}$/.test(cid)) {
        cid = UI.mockCidFor(body);
        uploadedIpfs = false;
      }
      steps.set(0, "done");

      // Step 2: purchase transaction (atomic: seat + mint + CID record).
      steps.set(1, "active");
      const settlement = await Wallet.write("TicketSettlement");
      const tx = await settlement.purchase(flightId, cid, {
        value: BigInt(flight.priceWei),
      });

      // Step 3: confirmation.
      steps.set(1, "done");
      steps.set(2, "active");
      const receipt = await tx.wait();
      if (receipt.status !== 1) throw new Error("transaction reverted");

      let tokenId = null;
      for (const log of receipt.logs) {
        try {
          const parsed = settlement.interface.parseLog(log);
          if (parsed && parsed.name === "PurchaseCompleted") {
            tokenId = Number(parsed.args.tokenId);
            break;
          }
        } catch {
          /* not a settlement log */
        }
      }
      steps.set(2, "done");

      done = true;
      const seat = await settlement.seatNumberByToken(tokenId).catch(() => null);
      successPanel.hidden = false;
      successPanel.innerHTML = `
        <section class="notice notice-info mt-4" aria-live="polite">
          <strong>Booking confirmed — ticket #${tokenId} minted.</strong>
          <div class="row mt-3">
            <span class="badge badge-issued">Seat ${UI.escapeHtml(seat ? `S-${seat}` : nextSeat)}</span>
            ${UI.sourceBadge(cid)}
            <span class="xsmall mono">${UI.escapeHtml(cid)}</span>
          </div>
          <div class="tx-hash">${UI.escapeHtml(receipt.hash)}</div>
          <div class="btn-row row mt-3">
            <a class="btn btn-primary" href="tickets.html">View my tickets</a>
            <a class="btn" href="flights.html">Book another flight</a>
          </div>
        </section>`;
      UI.toast("success", `Ticket #${tokenId} minted.`, receipt.hash);
      successPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      updateButton();
      // Refresh availability in the summary without reloading the page.
      const inventory = Wallet.read("FlightInventory");
      flight = await inventory.getFlight(flightId).catch(() => flight);
      renderSummary();
      renderPayment();
    } catch (err) {
      console.error("purchase failed", err);
      const msg = UI.revertMessage(err, Wallet.allContracts());
      const failIndex = !steps.node.children[0].className.includes("done")
        ? 0
        : !steps.node.children[1].className.includes("done")
          ? 1
          : 2;
      steps.fail(failIndex, null);
      UI.toast("error", msg);
      if (uploadedIpfs && cid) {
        UI.toast(
          "warn",
          `Purchase reverted — the uploaded metadata (${UI.shortHash(cid, 12, 6)}) was not attached to any ticket. This orphaned CID is harmless.`
        );
      }
      progressEl.hidden = false;
    } finally {
      submitting = false;
      updateButton();
    }
  }

  confirmBtn.addEventListener("click", onConfirm);
  credCheck.addEventListener("change", updateButton);
  disclosure.addEventListener("change", updateButton);
  Wallet.onChange(() => {
    renderMetadataPreview();
    updateButton();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", load);
  } else {
    load();
  }
})();
