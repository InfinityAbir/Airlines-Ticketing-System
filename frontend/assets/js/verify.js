// verify.html — wallet-less public verification (FR-31/FR-32).
// Reads go straight to the configured JSON-RPC endpoint (Wallet.readPublic); no injected
// wallet, no login, and no passenger identity fields are ever requested or displayed.
(function () {
  "use strict";

  const STATE_NAMES = ["Issued", "Listed", "Cancelled", "Refunded", "Used", "Invalid"];
  const VALIDITY = {
    Issued: { text: "Valid", cls: "badge-ok" },
    Listed: { text: "Listed for resale", cls: "badge-listed" },
    Cancelled: { text: "Cancelled", cls: "badge-cancelled" },
    Refunded: { text: "Cancelled", cls: "badge-cancelled" },
    Used: { text: "Used", cls: "badge-used" },
    Invalid: { text: "Invalid", cls: "badge-invalid" },
  };
  const SEAT_STATUS = {
    Issued: "assigned to this ticket",
    Listed: "assigned — listed for resale",
    Cancelled: "returned to the airline's inventory",
    Refunded: "returned to the airline's inventory",
    Used: "flown",
    Invalid: "void",
  };

  const notices = document.getElementById("page-notices");
  const form = document.getElementById("verify-form");
  const input = document.getElementById("ticket-id");
  const btn = document.getElementById("verify-btn");
  const resultEl = document.getElementById("verify-result");

  function setNotice(html) {
    notices.innerHTML = html || "";
  }

  function showInvalid(message) {
    setNotice(`<div class="notice notice-warn">${UI.escapeHtml(message)}</div>`);
    resultEl.hidden = true;
    resultEl.innerHTML = "";
  }

  function showNotFound(tokenId) {
    setNotice("");
    resultEl.hidden = false;
    resultEl.innerHTML = `
      <div class="notice notice-warn" role="status">
        <strong>Not found.</strong> There is no ticket with ID ${UI.escapeHtml(tokenId)} on this chain.
        Check the ID printed on the ticket (for example <code>#1</code>) and try again.
      </div>`;
  }

  async function verify(tokenId) {
    setNotice("");
    resultEl.hidden = true;
    resultEl.innerHTML = "";

    if (!Number.isInteger(tokenId) || tokenId < 1) {
      showInvalid("Enter a ticket ID — a whole number of 1 or more.");
      return;
    }
    if (Wallet.configMissing()) {
      setNotice(
        '<div class="notice notice-danger"><strong>Contract configuration missing.</strong> ' +
          "Run <code>npm run deploy</code>, then reload.</div>"
      );
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Checking…';
    }

    try {
      const nft = Wallet.readPublic("AirTicketNFT");
      let ticket;
      try {
        ticket = await nft.getTicket(tokenId);
      } catch (err) {
        const msg = UI.revertMessage(err, [nft]);
        if (/does not exist/i.test(msg) || /UnknownTicket/i.test(msg)) {
          showNotFound(tokenId);
          return;
        }
        throw err;
      }

      const stateName = STATE_NAMES[Number(ticket.state)] || "Invalid";
      const validity = VALIDITY[stateName] || { text: "Invalid", cls: "badge-invalid" };

      let flight = null;
      try {
        const inventory = Wallet.readPublic("FlightInventory");
        flight = await inventory.getFlight(ticket.flightId);
      } catch {
        /* flight record unavailable — the result still shows the ticket state */
      }

      const link = new URL(UI.verifyLink(tokenId), window.location.href).href;
      const qr = UI.qrDataUrl(link);

      setNotice("");
      resultEl.hidden = false;
      resultEl.innerHTML = `
        <section class="notice notice-info verify-result" aria-live="polite">
          <div class="row">
            <span class="badge ${validity.cls}">${validity.text}</span>
            <strong>Ticket #${tokenId}</strong>
            ${UI.statusBadge(stateName)}
          </div>
          <dl class="kv mt-3">
            <dt>Flight</dt>
            <dd>${flight ? `${UI.escapeHtml(flight.flightCode)} · ${UI.escapeHtml(flight.origin)} → ${UI.escapeHtml(flight.destination)}` : "Unavailable"}</dd>
            <dt>Departure</dt><dd>${flight ? UI.formatTimestamp(flight.departureTime) : "—"}</dd>
            <dt>Seat</dt>
            <dd><span class="mono">${UI.escapeHtml(ticket.seatReference)}</span> · ${UI.escapeHtml(SEAT_STATUS[stateName] || "—")}</dd>
            <dt>Operator</dt><dd class="mono">${flight ? UI.shortAddress(flight.airline, 10, 8) : "—"}</dd>
            <dt>Owner</dt><dd class="mono">${UI.shortAddress(ticket.owner, 10, 8)}</dd>
            <dt>Issued</dt><dd>${UI.formatTimestamp(ticket.issuedAt)}</dd>
          </dl>
          <div class="cid-line mt-3" data-cid-line>
            <span class="tick tick-warn" aria-hidden="true">·</span>
            <span>${UI.escapeHtml(ticket.metadataCID)}</span>
            ${UI.sourceBadge(ticket.metadataCID)}
            <span class="muted">verifying…</span>
          </div>
          <div class="ticket-verify mt-3">
            ${
              qr
                ? `<img class="qr-thumb-img" src="${qr}" alt="QR code linking to ${UI.escapeHtml(UI.verifyLink(tokenId))}">`
                : ""
            }
            <span class="xsmall muted">
              Deep link: <span class="mono">${UI.escapeHtml(UI.verifyLink(tokenId))}</span>
              · Read directly from the chain — no wallet needed.
            </span>
          </div>
          <p class="xsmall muted mt-3 mb-0">
            No passenger name, passport, credential or decrypted metadata is stored on-chain or shown here (FR-32).
          </p>
        </section>`;

      const line = resultEl.querySelector("[data-cid-line]");
      if (line) {
        const cidResult = await UI.verifyCid(ticket.metadataCID);
        const label = line.querySelector(".muted");
        if (label) {
          label.className = `tick ${cidResult.cls}`;
          label.textContent = cidResult.text;
        }
        const dot = line.querySelector(".tick:not(.muted)");
        if (dot) {
          dot.className = `tick ${cidResult.cls}`;
          dot.textContent = cidResult.cls === "tick-ok" ? "✓" : cidResult.cls === "tick-bad" ? "✕" : "·";
          dot.setAttribute("aria-hidden", "true");
        }
      }
    } catch (err) {
      console.error("verification failed", err);
      setNotice(
        '<div class="notice notice-danger"><strong>Could not read this ticket.</strong> ' +
          UI.escapeHtml(UI.revertMessage(err)) +
          " Is the Hardhat node running?</div>"
      );
      resultEl.hidden = true;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Verify ticket";
      }
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    verify(Number(input.value));
  });

  // Deep link support: verify.html?ticketId=1 (also what the ticket QR encodes).
  const params = new URLSearchParams(window.location.search);
  const linked = params.get("ticketId");
  if (linked != null && linked !== "") {
    input.value = linked;
    verify(Number(linked));
  }

  window.UI.bindPendingLinks(document);
})();
