// tickets.html — ticket wallet: boarding-pass cards, public CID verification (FR-17/18),
// purchase history. Phase 3/4 actions (cancel, list) render as explicit pending buttons.
(function () {
  "use strict";

  const ACTIVE_STATES = new Set(["Issued", "Listed"]);
  const notices = document.getElementById("page-notices");
  const activeList = document.getElementById("active-list");
  const pastList = document.getElementById("past-list");
  const historyBody = document.getElementById("history-body");
  const resultCount = document.getElementById("result-count");

  let loading = false;

  function setNotice(html) {
    notices.innerHTML = html || "";
  }

  function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  /// @notice Re-derive the fingerprint from retrieved metadata and compare (FR-18 demo).
  async function verifyCid(cid) {
    if (String(cid).startsWith("mock")) {
      return {
        cls: "tick-warn",
        text: "mock fallback — metadata was kept locally at purchase; nothing to fetch from IPFS",
      };
    }
    try {
      const res = await fetchWithTimeout(
        `${APP_CONFIG.ipfsGateway}${cid}`,
        APP_CONFIG.metadataFetchTimeoutMs
      );
      if (!res.ok) throw new Error(`gateway responded ${res.status}`);
      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("retrieved content is not JSON");
      }
      const stored = parsed.fingerprint;
      if (!stored) {
        return { cls: "tick-warn", text: "metadata retrieved but carries no fingerprint" };
      }
      const copy = { ...parsed };
      delete copy.fingerprint;
      const recomputed = UI.fingerprint(JSON.stringify(copy));
      return recomputed === stored
        ? { cls: "tick-ok", text: "IPFS metadata retrieved · fingerprint matches on-chain CID" }
        : { cls: "tick-bad", text: "metadata fingerprint mismatch — content altered after upload" };
    } catch (err) {
      console.warn("CID verification failed", err);
      return {
        cls: "tick-warn",
        text: "gateway unreachable — CID recorded on-chain, metadata not retrievable right now",
      };
    }
  }

  function ticketCardHtml(tokenId, t, flight) {
    const stateLabel = ["Issued", "Listed", "Cancelled", "Refunded", "Used", "Invalid"][Number(t.state)] || "Invalid";
    const route = flight
      ? `${UI.escapeHtml(flight.origin)} → ${UI.escapeHtml(flight.destination)}`
      : "Route unavailable";
    const code = flight ? UI.escapeHtml(flight.flightCode) : "—";

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
          </div>
          <div class="cid-line" data-cid-line>
            <span class="tick tick-warn" aria-hidden="true">·</span>
            <span>${UI.escapeHtml(t.metadataCID)}</span>
            ${UI.sourceBadge(t.metadataCID)}
            <span class="muted">verifying…</span>
          </div>
          <div class="ticket-actions">
            <button type="button" class="btn btn-sm" disabled
              title="Cancellation and refund arrive in Phase 3">Cancel &amp; refund</button>
            <button type="button" class="btn btn-sm" disabled
              title="Controlled resale arrives in Phase 4">List for resale</button>
            <button type="button" class="btn btn-sm btn-ghost" data-phase="Phase 3">Verify publicly</button>
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
    const result = await verifyCid(cid);
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

  async function loadHistory(address) {
    if (Wallet.configMissing()) return;
    const settlement = Wallet.read("TicketSettlement");
    const events = await settlement
      .queryFilter(settlement.filters.PurchaseCompleted(null, null, address))
      .catch(() => []);
    if (events.length === 0) {
      historyBody.innerHTML =
        '<tr><td colspan="5" class="empty-state">No purchases from this wallet yet.</td></tr>';
      return;
    }
    const sorted = events.slice().sort((a, b) => b.blockNumber - a.blockNumber);
    const blockNumbers = [...new Set(sorted.map((e) => e.blockNumber))];
    const blocks = await Promise.all(
      blockNumbers.map((bn) => settlement.runner.provider.getBlock(bn).catch(() => null))
    );
    const timeByBlock = new Map(
      blockNumbers.map((bn, i) => [bn, blocks[i] ? blocks[i].timestamp : null])
    );
    historyBody.innerHTML = sorted
      .map((e) => {
        const ts = timeByBlock.get(e.blockNumber);
        const flightId = Number(e.args.flightId);
        const tokenId = Number(e.args.tokenId);
        return `
          <tr>
            <td data-label="Time">${ts ? UI.formatTimestamp(ts) : `block ${e.blockNumber}`}</td>
            <td data-label="Flight">Flight #${flightId}</td>
            <td data-label="Ticket">#${tokenId}</td>
            <td data-label="Metadata">${UI.sourceBadge(e.args.cid)}</td>
            <td data-label="Transaction"><span class="mono xsmall">${UI.shortHash(e.transactionHash)}</span></td>
          </tr>`;
      })
      .join("");
  }

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

      const nextId = Number(await nft.nextTokenId());
      const tickets = [];
      for (let id = 1; id < nextId; id += 1) {
        try {
          const t = await nft.getTicket(id);
          if (t.owner.toLowerCase() === address.toLowerCase()) {
            tickets.push({ id, t });
          }
        } catch {
          /* ticket id not minted */
        }
      }

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

      const active = tickets.filter((r) =>
        ACTIVE_STATES.has(["Issued", "Listed", "Cancelled", "Refunded", "Used", "Invalid"][Number(r.t.state)])
      );
      const past = tickets.filter((r) => !active.includes(r));

      resultCount.textContent = `${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`;

      if (tickets.length === 0) {
        activeList.innerHTML =
          '<div class="notice empty-state" style="grid-column:1/-1">No tickets in this wallet yet. ' +
          '<a href="flights.html">Browse flights</a> to book your first seat.</div>';
        pastList.innerHTML = "";
        historyBody.innerHTML =
          '<tr><td colspan="5" class="empty-state">No purchases from this wallet yet.</td></tr>';
        return;
      }

      activeList.innerHTML =
        active.length > 0
          ? active
              .map((r) => ticketCardHtml(r.id, r.t, flights.get(Number(r.t.flightId))))
              .join("")
          : '<div class="notice empty-state" style="grid-column:1/-1">No active tickets.</div>';
      pastList.innerHTML =
        past.length > 0
          ? past
              .map((r) => ticketCardHtml(r.id, r.t, flights.get(Number(r.t.flightId))))
              .join("")
          : '<div class="notice empty-state" style="grid-column:1/-1">No past tickets.</div>';

      // Verify each ticket's CID (network-dependent; runs after paint).
      document.querySelectorAll(".ticket[data-token]").forEach((card) => {
        const id = Number(card.dataset.token);
        const rec = tickets.find((x) => x.id === id);
        if (rec) verifyCard(card, rec.t.metadataCID);
      });
      UI.bindPendingLinks(document);

      await loadHistory(address);
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
