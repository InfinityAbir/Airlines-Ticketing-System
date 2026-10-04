// admin.html — platform administration: airline approvals (FR-06), platform limits,
// emergency pause controls with a live coverage matrix, and the FR-34 filtered audit feed.
// Scope guard: this page only governs roles, limits and pause switches — it can never move
// a ticket, transfer ETH, or change a balance (DESIGN §3.7). Reads are wallet-less so the
// audit feed works for a guest; every write re-checks the admin role on-chain (FR-04).
(function () {
  "use strict";

  // ARCHITECTURE §10: bounded event scans — no indexer in R1, but never an open-ended range.
  const MAX_SCAN_BLOCKS = 100000;
  const STATE_NAMES = ["Issued", "Listed", "Cancelled", "Refunded", "Used", "Invalid"];
  const APPROVAL_TYPES = ["airline_approved", "airline_deactivated", "airline_reactivated"];

  // Event catalogue driving the FR-34 "event type" filter and every row's wording.
  const TYPES = {
    airline_approved: { label: "Airline approved", cat: "Administration" },
    airline_deactivated: { label: "Airline deactivated", cat: "Administration" },
    airline_reactivated: { label: "Airline reactivated", cat: "Administration" },
    limits_updated: { label: "Platform limits updated", cat: "Administration" },
    platform_paused: { label: "Platform paused", cat: "Administration" },
    platform_unpaused: { label: "Platform resumed", cat: "Administration" },
    booking_paused: { label: "Bookings paused", cat: "Administration" },
    booking_unpaused: { label: "Bookings resumed", cat: "Administration" },
    resale_paused: { label: "Resale paused", cat: "Administration" },
    resale_unpaused: { label: "Resale resumed", cat: "Administration" },
    wiring_updated: { label: "Contract wiring updated", cat: "Administration" },
    settlement_updated: { label: "Settlement updated", cat: "Administration" },
    revenue_withdrawn: { label: "Revenue withdrawn", cat: "Administration" },
    flight_created: { label: "Flight created", cat: "Flights" },
    flight_published: { label: "Flight published", cat: "Flights" },
    flight_sales_paused: { label: "Flight sales paused", cat: "Flights" },
    flight_cancelled: { label: "Flight cancelled", cat: "Flights" },
    flight_departed: { label: "Flight departed", cat: "Flights" },
    seat_reserved: { label: "Seat reserved", cat: "Flights" },
    seat_released: { label: "Seat returned", cat: "Flights" },
    ticket_booked: { label: "Seat booked", cat: "Tickets" },
    ticket_minted: { label: "Ticket minted", cat: "Tickets" },
    ticket_cancelled: { label: "Ticket cancelled", cat: "Tickets" },
    refund_paid: { label: "Refund paid", cat: "Tickets" },
    ticket_used: { label: "Ticket marked used", cat: "Tickets" },
    ticket_invalidated: { label: "Ticket invalidated", cat: "Tickets" },
    ticket_transferred: { label: "Ticket transferred", cat: "Tickets" },
    ticket_listed: { label: "Ticket listed", cat: "Tickets" },
    ticket_delisted: { label: "Ticket delisted", cat: "Tickets" },
    listing_created: { label: "Listing published", cat: "Resale" },
    listing_cancelled: { label: "Listing withdrawn", cat: "Resale" },
    listing_sold: { label: "Resale settled", cat: "Resale" },
  };
  const CAT_ORDER = ["Administration", "Flights", "Tickets", "Resale"];
  const CAT_BADGE = {
    Administration: "badge-info",
    Flights: "badge-published",
    Tickets: "badge-issued",
    Resale: "badge-listed",
  };

  const notices = document.getElementById("page-notices");
  const statsRow = document.getElementById("stats-row");
  const approvalsCard = document.getElementById("approvals-card");
  const limitsCard = document.getElementById("limits-card");
  const pauseCard = document.getElementById("pause-card");
  const approvalsBody = document.getElementById("approvals-body");
  const pauseMatrixBody = document.getElementById("pause-matrix-body");
  const auditBody = document.getElementById("audit-body");
  const auditHint = document.getElementById("audit-hint");
  const platformPill = document.getElementById("platform-pill");
  const approveForm = document.getElementById("approve-form");
  const approveBtn = document.getElementById("approve-btn");
  const limitsForm = document.getElementById("limits-form");
  const limitsBtn = document.getElementById("limits-btn");
  const filterType = document.getElementById("filter-type");
  const filterFlight = document.getElementById("filter-flight");
  const filterAirline = document.getElementById("filter-airline");
  const filterState = document.getElementById("filter-state");

  let isAdmin = false;
  let platformPaused = false;
  let settlementPaused = false;
  let marketplacePaused = false;
  let limits = { maxRoyaltyBps: 1000, maxRefundBps: 10000 };
  let limitsUpdatedAt = null;
  let flights = [];
  let tickets = [];
  let events = [];
  let candidates = [];
  let loading = false;

  const flightsById = new Map();
  const ticketsById = new Map();

  // ---- Small helpers ----

  function setNotice(html) {
    notices.innerHTML = html || "";
  }

  function setError(id, message) {
    const input = document.getElementById(id);
    const span = document.querySelector(`[data-error-for="${id}"]`);
    if (span) span.textContent = message || "";
    if (input) {
      if (message) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
  }

  function clearErrors() {
    ["f-wallet", "f-royalty-cap", "f-refund-cap"].forEach((id) => setError(id, ""));
  }

  function addrHtml(addr) {
    if (!addr) return "—";
    return `<span class="mono" title="${UI.escapeHtml(addr)}">${UI.escapeHtml(
      UI.shortAddress(addr, 8, 6)
    )}</span>`;
  }

  function flightRef(id) {
    const f = flightsById.get(Number(id));
    if (!f) return `flight #${id}`;
    return `<span class="mono">${UI.escapeHtml(f.flightCode)}</span> <span class="xsmall muted">#${Number(f.flightId)}</span>`;
  }

  function ticketRef(tokenId) {
    const t = ticketsById.get(Number(tokenId));
    const seat = t && t.seatReference ? ` <span class="mono xsmall">${UI.escapeHtml(t.seatReference)}</span>` : "";
    return `<strong>#${Number(tokenId)}</strong>${seat}`;
  }

  function stateBadge(idx) {
    return idx == null ? "" : ` ${UI.statusBadgeFromIndex(idx)}`;
  }

  // Only the three write surfaces are gated; stats and the audit feed are public reads.
  function hideAdminCards() {
    approvalsCard.hidden = true;
    limitsCard.hidden = true;
    pauseCard.hidden = true;
  }

  function showAdminCards() {
    approvalsCard.hidden = false;
    limitsCard.hidden = false;
    pauseCard.hidden = false;
  }

  // ---- Event normalisation (raw contract log -> one audit row) ----

  function row(type, extra) {
    const meta = TYPES[type];
    return Object.assign(
      {
        type,
        label: meta.label,
        cat: meta.cat,
        flightId: null,
        airline: null,
        tokenId: null,
        stateIdx: null,
        details: "",
        blockNumber: 0,
        logIndex: 0,
        time: null,
        hash: "",
      },
      extra
    );
  }

  function buildRow(kind, parsed) {
    const g = (n) => parsed.args[n];
    const flightAirline = (id) => {
      const f = flightsById.get(Number(id));
      return f ? f.airline : null;
    };

    // OZ Pausable emits the same names on three contracts — disambiguate by source.
    if (parsed.name === "Paused" || parsed.name === "Unpaused") {
      const on = parsed.name === "Paused";
      if (kind === "registry") {
        return row(on ? "platform_paused" : "platform_unpaused", {
          details: on
            ? "platform pause engaged — flight creation, booking, listing, resale and ticket transfers are blocked"
            : "platform pause lifted — normal operations resume",
        });
      }
      if (kind === "settlement") {
        return row(on ? "booking_paused" : "booking_unpaused", {
          details: on
            ? "settlement pause engaged — new ticket purchases are blocked (cancel and refund stay available)"
            : "settlement pause lifted — ticket purchases resume",
        });
      }
      if (kind === "marketplace") {
        return row(on ? "resale_paused" : "resale_unpaused", {
          details: on
            ? "marketplace pause engaged — new resale listings and resale purchases are blocked"
            : "marketplace pause lifted — resale resumes",
        });
      }
      return null;
    }

    switch (kind) {
      case "registry":
        switch (parsed.name) {
          case "AirlineApproved":
            return row("airline_approved", {
              airline: g("wallet"),
              details: `${addrHtml(g("wallet"))} approved as an airline operator`,
            });
          case "AirlineDeactivated":
            return row("airline_deactivated", {
              airline: g("wallet"),
              details: `${addrHtml(g("wallet"))} deactivated — its existing flights stay on record`,
            });
          case "AirlineReactivated":
            return row("airline_reactivated", {
              airline: g("wallet"),
              details: `${addrHtml(g("wallet"))} reactivated as an airline operator`,
            });
          case "LimitsUpdated":
            return row("limits_updated", {
              details: `resale royalty cap ${UI.escapeHtml(
                UI.formatBpsToPct(g("maxRoyaltyBps"))
              )} · refund cap ${UI.escapeHtml(UI.formatBpsToPct(g("maxRefundBps")))}`,
            });
          default:
            return null;
        }
      case "inventory":
        switch (parsed.name) {
          case "FlightCreated":
            return row("flight_created", {
              flightId: Number(g("flightId")),
              airline: g("airline"),
              details: `${flightRef(g("flightId"))} created as a draft by ${addrHtml(g("airline"))}`,
            });
          case "FlightPublished":
            return row("flight_published", {
              flightId: Number(g("flightId")),
              airline: flightAirline(g("flightId")),
              details: `${flightRef(g("flightId"))} published — sales open`,
            });
          case "FlightSalesPaused":
            return row("flight_sales_paused", {
              flightId: Number(g("flightId")),
              airline: flightAirline(g("flightId")),
              details: `${flightRef(g("flightId"))} sales paused by its airline`,
            });
          case "FlightCancelled":
            return row("flight_cancelled", {
              flightId: Number(g("flightId")),
              airline: flightAirline(g("flightId")),
              details: `${flightRef(g("flightId"))} cancelled — terminal state`,
            });
          case "FlightDeparted":
            return row("flight_departed", {
              flightId: Number(g("flightId")),
              airline: flightAirline(g("flightId")),
              details: `${flightRef(g("flightId"))} marked departed — refund and resale windows closed`,
            });
          case "SeatReserved":
            return row("seat_reserved", {
              flightId: Number(g("flightId")),
              airline: flightAirline(g("flightId")),
              details: `seat reserved on ${flightRef(g("flightId"))} — ${Number(g("seatsAvailable"))} left`,
            });
          case "SeatReleased":
            return row("seat_released", {
              flightId: Number(g("flightId")),
              airline: flightAirline(g("flightId")),
              details: `seat returned to ${flightRef(g("flightId"))} — ${Number(g("seatsAvailable"))} available`,
            });
          case "AuthorizedPartiesUpdated":
            return row("wiring_updated", {
              details: `settlement ${addrHtml(g("settlement"))} and marketplace ${addrHtml(
                g("marketplace")
              )} authorized to move seats`,
            });
          default:
            return null;
        }
      case "nft":
        switch (parsed.name) {
          case "TicketMinted":
            return row("ticket_minted", {
              flightId: Number(g("flightId")),
              airline: flightAirline(g("flightId")),
              tokenId: Number(g("tokenId")),
              stateIdx: 0,
              details: `ticket ${ticketRef(g("tokenId"))} minted to ${addrHtml(g("owner"))} on ${flightRef(
                g("flightId")
              )} ${UI.sourceBadge(g("cid"))}`,
            });
          case "TicketInvalidated":
            return ticketRow(g("tokenId"), "ticket_invalidated", 5, "ticket invalidated — permanent terminal state");
          case "TicketMarkedUsed":
            return ticketRow(g("tokenId"), "ticket_used", 4, "marked used at boarding");
          case "TicketTransferred":
            return ticketRow(
              g("tokenId"),
              "ticket_transferred",
              null,
              `moved from ${addrHtml(g("from"))} to ${addrHtml(g("to"))} through settlement`
            );
          case "TicketListed":
            return ticketRow(g("tokenId"), "ticket_listed", 1, "moved to Listed while a resale offer is active");
          case "TicketDelisted":
            return ticketRow(g("tokenId"), "ticket_delisted", 0, "offer withdrawn — back to Issued");
          case "SettlementUpdated":
            return row("settlement_updated", { details: `settlement contract set to ${addrHtml(g("settlement"))}` });
          default:
            return null;
        }
      case "settlement":
        switch (parsed.name) {
          case "PurchaseCompleted":
            return row("ticket_booked", {
              flightId: Number(g("flightId")),
              airline: flightAirline(g("flightId")),
              tokenId: Number(g("tokenId")),
              stateIdx: 0,
              details: `seat booked on ${flightRef(g("flightId"))} by ${addrHtml(
                g("buyer")
              )} — ticket ${ticketRef(g("tokenId"))} issued ${UI.sourceBadge(g("cid"))}`,
            });
          case "TicketCancelled":
            return ticketRow(g("tokenId"), "ticket_cancelled", 2, `cancelled by ${addrHtml(g("owner"))} for a policy refund`);
          case "TicketRefunded":
            return ticketRow(
              g("tokenId"),
              "refund_paid",
              2,
              `refund ${UI.ethFormat(g("refund"))} returned · ${UI.ethFormat(g("retained"))} retained by the airline`
            );
          case "AirlineWithdrawn":
            return row("revenue_withdrawn", {
              airline: g("airline"),
              details: `${UI.ethFormat(g("amount"))} of accrued revenue withdrawn by ${addrHtml(g("airline"))}`,
            });
          default:
            return null;
        }
      case "marketplace":
        switch (parsed.name) {
          case "ListingCreated":
            return row("listing_created", {
              tokenId: Number(g("tokenId")),
              stateIdx: 1,
              details: `ticket ${ticketRef(g("tokenId"))} listed for ${UI.ethFormat(
                g("priceWei")
              )} by ${addrHtml(g("seller"))} · expires ${UI.escapeHtml(UI.timestampText(g("expiresAt")))}`,
            });
          case "ListingCancelled":
            return listingRow(g("listingId"), "listing_cancelled", "offer withdrawn by the seller");
          case "ListingSold":
            return row("listing_sold", {
              tokenId: Number(g("tokenId")),
              stateIdx: 0,
              details: `ticket ${ticketRef(g("tokenId"))} resold for ${UI.ethFormat(g("priceWei"))} — royalty ${UI.ethFormat(
                g("royalty")
              )} to the airline, ${UI.ethFormat(g("sellerProceeds"))} to the seller`,
            });
          default:
            return null;
        }
      default:
        return null;
    }
  }

  // Resolves a ticket id to the row's flight/airline so filters can match on both.
  function ticketRow(tokenId, type, stateIdx, details) {
    const id = Number(tokenId);
    const t = ticketsById.get(id);
    const flightId = t ? Number(t.flightId) : null;
    const f = flightId != null ? flightsById.get(flightId) : null;
    return row(type, {
      tokenId: id,
      flightId,
      airline: f ? f.airline : null,
      stateIdx,
      details: `ticket ${ticketRef(id)} ${details}`,
    });
  }

  async function listingRow(listingId, type, details) {
    // `ListingCancelled` carries only the listing id; resolve ticket for the filters.
    const id = Number(listingId);
    let tokenId = null;
    try {
      const marketplace = Wallet.readPublic("TicketMarketplace");
      const listing = await marketplace.getListing(id);
      tokenId = Number(listing.tokenId);
    } catch {
      /* listing already gone from the mapping */
    }
    const t = tokenId != null ? ticketsById.get(tokenId) : null;
    const flightId = t ? Number(t.flightId) : null;
    const f = flightId != null ? flightsById.get(flightId) : null;
    return row(type, {
      tokenId,
      flightId,
      airline: f ? f.airline : null,
      stateIdx: 0,
      details: `listing #${id}${tokenId != null ? ` for ticket ${ticketRef(tokenId)}` : ""} ${details}`,
    });
  }

  // ---- Data loading ----

  async function loadFlights(inventory) {
    const nextId = Number(await inventory.nextFlightId());
    flights = [];
    flightsById.clear();
    for (let id = 1; id < nextId; id += 1) {
      try {
        const f = await inventory.getFlight(id);
        flights.push(f);
        flightsById.set(id, f);
      } catch {
        /* skip unknown id */
      }
    }
  }

  async function loadTickets(nft) {
    const nextId = Number(await nft.nextTokenId());
    tickets = [];
    ticketsById.clear();
    for (let id = 1; id < nextId; id += 1) {
      try {
        const t = await nft.getTicket(id);
        tickets.push(t);
        ticketsById.set(id, t);
      } catch {
        /* skip unknown id */
      }
    }
  }

  async function loadEvents() {
    const registry = Wallet.readPublic("AirlineRegistry");
    const provider = registry.runner;
    const config = Wallet.config;
    const kindByAddress = new Map(
      Object.entries(config.addresses).map(([name, address]) => {
        const kind =
          name === "AirlineRegistry"
            ? "registry"
            : name === "FlightInventory"
              ? "inventory"
              : name === "AirTicketNFT"
                ? "nft"
                : name === "TicketSettlement"
                  ? "settlement"
                  : "marketplace";
        return [String(address).toLowerCase(), kind];
      })
    );

    const latest = await provider.getBlock("latest");
    const fromBlock = Math.max(0, latest.number - MAX_SCAN_BLOCKS);
    const logs = await provider.getLogs({ fromBlock, toBlock: latest.number });

    const decoded = [];
    for (const log of logs) {
      const kind = kindByAddress.get(String(log.address).toLowerCase());
      if (!kind) continue;
      const contract = Wallet.readPublic(
        kind === "registry"
          ? "AirlineRegistry"
          : kind === "inventory"
            ? "FlightInventory"
            : kind === "nft"
              ? "AirTicketNFT"
              : kind === "settlement"
                ? "TicketSettlement"
                : "TicketMarketplace"
      );
      let parsed;
      try {
        parsed = contract.interface.parseLog(log);
      } catch {
        continue;
      }
      if (!parsed) continue;
      const r = await buildRow(kind, parsed);
      if (!r) continue;
      r.blockNumber = log.blockNumber;
      r.logIndex = log.index;
      r.hash = log.transactionHash;
      decoded.push(r);
    }

    const blockNumbers = [...new Set(decoded.map((r) => r.blockNumber))];
    const blocks = await Promise.all(blockNumbers.map((bn) => provider.getBlock(bn).catch(() => null)));
    const timeByBlock = new Map(blockNumbers.map((bn, i) => [bn, blocks[i] ? blocks[i].timestamp : null]));
    decoded.forEach((r) => {
      r.time = timeByBlock.get(r.blockNumber) || null;
    });
    decoded.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
    events = decoded;
  }

  async function loadCandidates(registry) {
    const map = new Map();
    const add = (addr) => {
      if (!addr) return null;
      const key = String(addr).toLowerCase();
      if (!map.has(key)) {
        map.set(key, {
          address: addr,
          flightCount: 0,
          approved: false,
          wasApproved: false,
          lastLabel: "",
          lastTime: null,
        });
      }
      return map.get(key);
    };

    flights.forEach((f) => {
      const entry = add(f.airline);
      if (entry) entry.flightCount += 1;
    });

    events.forEach((r) => {
      if (!APPROVAL_TYPES.includes(r.type)) return;
      const entry = add(r.airline);
      if (!entry) return;
      if (r.type === "airline_approved") entry.wasApproved = true;
      if (!entry.lastLabel) {
        entry.lastLabel = r.label;
        entry.lastTime = r.time;
      }
    });

    await Promise.all(
      [...map.values()].map(async (entry) => {
        entry.approved = await registry.isApproved(entry.address).catch(() => false);
      })
    );

    candidates = [...map.values()].sort((a, b) => {
      if (a.approved !== b.approved) return a.approved ? -1 : 1;
      if (a.flightCount !== b.flightCount) return b.flightCount - a.flightCount;
      return a.address.localeCompare(b.address);
    });
  }

  // ---- Rendering ----

  function renderStats() {
    document.getElementById("stat-platform").innerHTML = platformPaused
      ? '<span class="badge badge-danger">Paused</span>'
      : '<span class="badge badge-ok">Live</span>';
    document.getElementById("stat-airlines").textContent = String(
      candidates.filter((c) => c.approved).length
    );
    document.getElementById("stat-flights").textContent = String(flights.length);
    document.getElementById("stat-tickets").textContent = String(tickets.length);
    statsRow.hidden = false;
    platformPill.textContent = platformPaused
      ? `${candidates.length} operator wallets · platform paused`
      : `${candidates.length} operator wallets · platform live`;
  }

  function renderApprovals() {
    if (candidates.length === 0) {
      approvalsBody.innerHTML =
        '<tr><td colspan="5" class="empty-state">No airline operators yet — approve a wallet above or run <code>npm run seed</code>.</td></tr>';
      return;
    }
    approvalsBody.innerHTML = candidates
      .map((c) => {
        const actions = [];
        if (c.approved) {
          actions.push(
            `<button type="button" class="btn btn-sm btn-danger" data-admin-action="deactivate" data-wallet="${UI.escapeHtml(
              c.address
            )}">Deactivate</button>`
          );
        } else {
          const method = c.wasApproved ? "reactivate" : "approve";
          const label = c.wasApproved ? "Reactivate" : "Approve";
          actions.push(
            `<button type="button" class="btn btn-sm btn-primary" data-admin-action="${method}" data-wallet="${UI.escapeHtml(
              c.address
            )}">${label}</button>`
          );
        }
        return `
          <tr>
            <td data-label="Wallet"><span class="mono" title="${UI.escapeHtml(c.address)}">${UI.escapeHtml(
              c.address
            )}</span></td>
            <td data-label="Status">${
              c.approved
                ? '<span class="badge badge-ok">Approved</span>'
                : '<span class="badge badge-idle">Disabled</span>'
            }</td>
            <td data-label="Flights">${c.flightCount}</td>
            <td data-label="Last registry event">${
              c.lastLabel
                ? `${UI.escapeHtml(c.lastLabel)}${c.lastTime ? ` · ${UI.formatTimestamp(c.lastTime)}` : ""}`
                : '<span class="muted">—</span>'
            }</td>
            <td class="actions" data-label="Actions">${actions.join("")}</td>
          </tr>`;
      })
      .join("");
  }

  function setLimitInput(id, chainValue) {
    const el = document.getElementById(id);
    // A background refresh must never silently discard an edit in progress: keep the
    // draft until it matches the chain (which is also how a saved value clears).
    if (el.dataset.dirty === "1" && Number(el.value) !== Number(chainValue)) return;
    el.value = chainValue;
    delete el.dataset.dirty;
  }

  function renderLimits() {
    document.getElementById("limit-royalty-now").textContent = UI.formatBpsToPct(limits.maxRoyaltyBps);
    document.getElementById("limit-refund-now").textContent = UI.formatBpsToPct(limits.maxRefundBps);
    document.getElementById("limit-updated").innerHTML = limitsUpdatedAt
      ? UI.formatTimestamp(limitsUpdatedAt)
      : '<span class="muted">not updated yet &#8212; R1 defaults</span>';
    setLimitInput("f-royalty-cap", (Number(limits.maxRoyaltyBps) / 100).toFixed(2));
    setLimitInput("f-refund-cap", (Number(limits.maxRefundBps) / 100).toFixed(2));
    UI.setBusy(limitsBtn, false);
    limitsCard.hidden = false;
  }

  const PAUSE_BUTTONS = {
    registry: { id: "btn-registry", live: "Pause platform", paused: "Resume platform" },
    settlement: { id: "btn-settlement", live: "Pause bookings", paused: "Resume bookings" },
    marketplace: { id: "btn-marketplace", live: "Pause resale", paused: "Resume resale" },
  };

  function setPauseChip(id, paused, label) {
    document.getElementById(id).innerHTML = paused
      ? `<span class="badge badge-danger">${UI.escapeHtml(label)}</span>`
      : '<span class="badge badge-ok">Live</span>';
  }

  function renderPause() {
    setPauseChip("pause-registry", platformPaused, "Paused");
    setPauseChip("pause-settlement", settlementPaused, "Paused");
    setPauseChip("pause-marketplace", marketplacePaused, "Paused");

    Object.entries(PAUSE_BUTTONS).forEach(([key, cfg]) => {
      const btn = document.getElementById(cfg.id);
      const paused = key === "registry" ? platformPaused : key === "settlement" ? settlementPaused : marketplacePaused;
      UI.setBusy(btn, false);
      btn.textContent = paused ? cfg.paused : cfg.live;
      btn.className = `btn btn-sm mt-3 ${paused ? "btn-primary" : "btn-danger"}`;
    });
    pauseCard.hidden = false;
    renderPauseMatrix();
  }

  function renderPauseMatrix() {
    const rows = [
      ["Create or publish a flight", platformPaused, platformPaused ? "Platform pause" : ""],
      ["Buy a ticket", platformPaused || settlementPaused, blockedBy(platformPaused, settlementPaused, "Platform", "Booking")],
      ["List a ticket for resale", platformPaused || marketplacePaused, blockedBy(platformPaused, marketplacePaused, "Platform", "Resale")],
      ["Buy a resale listing", platformPaused || marketplacePaused, blockedBy(platformPaused, marketplacePaused, "Platform", "Resale")],
      ["Ticket transfer during settlement", platformPaused, platformPaused ? "Platform pause" : ""],
      ["Cancel and refund a ticket", false, ""],
      ["Mark a ticket used (boarding)", false, ""],
      ["Mark a flight departed", false, ""],
      ["Reads, verification and this feed", false, ""],
    ];
    pauseMatrixBody.innerHTML = rows
      .map(
        ([op, blocked, source]) => `
        <tr>
          <td data-label="Operation">${UI.escapeHtml(op)}</td>
          <td data-label="Right now">${
            blocked ? '<span class="badge badge-danger">Blocked</span>' : '<span class="badge badge-ok">Available</span>'
          }</td>
          <td data-label="Blocked by">${blocked ? UI.escapeHtml(source) : '<span class="muted">—</span>'}</td>
        </tr>`
      )
      .join("");
  }

  function blockedBy(a, b, nameA, nameB) {
    if (a && b) return `${nameA} + ${nameB} pause`;
    if (a) return `${nameA} pause`;
    if (b) return `${nameB} pause`;
    return "";
  }

  function populateTypeFilter() {
    filterType.innerHTML = '<option value="">All event types</option>';
    CAT_ORDER.forEach((cat) => {
      const group = document.createElement("optgroup");
      group.label = cat;
      Object.entries(TYPES).forEach(([key, meta]) => {
        if (meta.cat !== cat) return;
        const option = document.createElement("option");
        option.value = key;
        option.textContent = meta.label;
        group.appendChild(option);
      });
      filterType.appendChild(group);
    });
  }

  function replaceOptions(select, options, allLabel) {
    const current = select.value;
    select.innerHTML = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = allLabel;
    select.appendChild(all);
    options.forEach(({ value, label }) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      select.appendChild(o);
    });
    select.value = [...select.options].some((o) => o.value === current) ? current : "";
  }

  function populateEntityFilters() {
    const flightOptions = flights
      .slice()
      .sort((a, b) => Number(b.flightId) - Number(a.flightId))
      .map((f) => ({
        value: String(Number(f.flightId)),
        label: `${f.flightCode} #${Number(f.flightId)} · ${f.origin}→${f.destination}`,
      }));
    replaceOptions(filterFlight, flightOptions, "All flights");

    const airlines = candidates
      .slice()
      .sort((a, b) => a.address.localeCompare(b.address))
      .map((c) => ({
        value: c.address,
        label: `${UI.shortAddress(c.address, 8, 6)} (${c.flightCount} flight${c.flightCount === 1 ? "" : "s"})`,
      }));
    replaceOptions(filterAirline, airlines, "All airlines");
  }

  function filteredEvents() {
    const type = filterType.value;
    const flight = filterFlight.value;
    const airline = filterAirline.value ? filterAirline.value.toLowerCase() : "";
    const state = filterState.value;
    return events.filter((r) => {
      if (type && r.type !== type) return false;
      if (flight && String(r.flightId ?? "") !== flight) return false;
      if (airline && String(r.airline || "").toLowerCase() !== airline) return false;
      if (state === "none") return r.stateIdx == null;
      if (state) return r.stateIdx === STATE_NAMES.indexOf(state);
      return true;
    });
  }

  function renderAudit() {
    const rows = filteredEvents();
    auditHint.textContent = `FR-34 — read-only event trail · ${rows.length} of ${events.length} events`;
    const empty = events.length === 0
      ? "No events yet — create or publish a flight to populate the audit feed."
      : "No events match these filters.";
    auditBody.innerHTML = UI.txHistoryRows(
      rows.map((r) => ({
        time: r.time ? UI.formatTimestamp(r.time) : `block ${r.blockNumber}`,
        badge: `<span class="badge ${CAT_BADGE[r.cat] || "badge-idle"}">${UI.escapeHtml(
          r.label
        )}</span>${stateBadge(r.stateIdx)}`,
        details: r.details,
        hash: r.hash,
      })),
      empty,
      4
    );
  }

  // ---- Load / gating ----

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
        hideAdminCards();
        platformPill.textContent = "Contracts not loaded";
        auditBody.innerHTML = '<tr><td colspan="4" class="empty-state">Contracts not loaded.</td></tr>';
        return;
      }

      const registry = Wallet.readPublic("AirlineRegistry");
      const inventory = Wallet.readPublic("FlightInventory");
      const nft = Wallet.readPublic("AirTicketNFT");
      const settlement = Wallet.readPublic("TicketSettlement");
      const marketplace = Wallet.readPublic("TicketMarketplace");

      [platformPaused, settlementPaused, marketplacePaused, limits.maxRoyaltyBps, limits.maxRefundBps] =
        await Promise.all([
          registry.paused().catch(() => false),
          settlement.paused().catch(() => false),
          marketplace.paused().catch(() => false),
          registry.maxRoyaltyBps(),
          registry.maxRefundBps(),
        ]);

      await loadFlights(inventory);
      await loadTickets(nft);
      await loadEvents();
      await loadCandidates(registry);

      const limitsEvent = events.find((e) => e.type === "limits_updated");
      limitsUpdatedAt = limitsEvent ? limitsEvent.time : null;

      isAdmin = Boolean(Wallet.state.address) && Wallet.state.role === "admin";

      const noticeHtml = [];
      if (!Wallet.state.address) {
        noticeHtml.push(
          '<div class="notice"><strong>Public audit view.</strong> Connect the administrator wallet to approve operators, ' +
            'edit platform limits and trigger emergency pauses. The feed below needs no wallet.</div>'
        );
        hideAdminCards();
      } else if (!isAdmin) {
        noticeHtml.push(
          '<div class="notice notice-info"><strong>Not authorized for this space.</strong> This page is read-only for ' +
            `<span class="mono">${UI.escapeHtml(UI.shortAddress(Wallet.state.address, 10, 8))}</span> — ` +
            "airline approvals, platform limits and pause switches require the administrator wallet.</div>"
        );
        hideAdminCards();
      } else {
        if (!Wallet.isSupportedChain()) {
          noticeHtml.push(
            `<div class="notice notice-warn"><strong>Wrong network.</strong> Switch to Hardhat chain ${Wallet.expectedChainId()} before writing. ` +
              '<button type="button" class="btn btn-sm" id="inline-switch">Switch network</button></div>'
          );
        } else {
          noticeHtml.push(
            '<div class="notice notice-info"><strong>Administrator session.</strong> Approvals, limits and pause switches ' +
              "take effect immediately for every page of this prototype.</div>"
          );
        }
        showAdminCards();
      }

      if (platformPaused) {
        noticeHtml.push(
          '<div class="notice notice-warn"><strong>Platform paused.</strong> Booking, listing, resale and ticket transfers are blocked; ' +
            "cancellation, refunds, boarding and departure stay available.</div>"
        );
      } else if (settlementPaused || marketplacePaused) {
        noticeHtml.push(
          `<div class="notice notice-warn"><strong>${settlementPaused && marketplacePaused ? "Booking and resale" : settlementPaused ? "Booking" : "Resale"} paused locally.</strong> ` +
            "The platform-wide pause is still live; other flows are unaffected.</div>"
        );
      }
      setNotice(noticeHtml.join(""));
      const sw = document.getElementById("inline-switch");
      if (sw) sw.addEventListener("click", () => Wallet.ensureChain());

      renderStats();
      renderApprovals();
      if (isAdmin) renderLimits();
      if (isAdmin) renderPause();
      populateEntityFilters();
      renderAudit();
    } catch (err) {
      console.error(err);
      setNotice(
        '<div class="notice notice-danger"><strong>Could not load administration data.</strong> ' +
          UI.escapeHtml(UI.revertMessage(err, Wallet.allContracts())) +
          " Is the Hardhat node running?</div>"
      );
    } finally {
      loading = false;
    }
  }

  // ---- Writes ----

  async function runAdminAction({ contract, method, args, confirmTitle, confirmBody, confirmText, danger, button, busyLabel, success }) {
    const confirmed = await UI.confirmModal({
      title: confirmTitle,
      body: `<p>${confirmBody}</p>`,
      confirmText,
      danger,
    });
    if (!confirmed) return false;
    if (!(await Wallet.requireWrite())) return false;

    if (button) UI.setBusy(button, true, busyLabel);
    try {
      const instance = await Wallet.write(contract);
      const tx = await instance[method](...args);
      const receipt = await tx.wait();
      UI.toast("success", success, receipt.hash);
      // Release the button before the reload so the fresh label/state wins over the spinner.
      if (button) UI.setBusy(button, false);
      await load();
      return true;
    } catch (err) {
      console.error(err);
      UI.toast("error", UI.revertMessage(err, Wallet.allContracts()));
      if (button) UI.setBusy(button, false);
      return false;
    }
  }

  async function onApproveSubmit(e) {
    e.preventDefault();
    clearErrors();
    const raw = document.getElementById("f-wallet").value.trim();
    let wallet = null;
    try {
      wallet = ethers.getAddress(raw);
    } catch {
      setError("f-wallet", "Enter a valid address (0x followed by 40 hex characters).");
      return;
    }
    if (wallet === ethers.ZeroAddress) {
      setError("f-wallet", "The zero address cannot be an operator.");
      return;
    }
    const existing = candidates.find((c) => c.address.toLowerCase() === wallet.toLowerCase());
    if (existing && existing.approved) {
      setError("f-wallet", "That wallet is already approved.");
      return;
    }

    const ok = await runAdminAction({
      contract: "AirlineRegistry",
      method: existing && existing.wasApproved ? "reactivateAirline" : "approveAirline",
      args: [wallet],
      confirmTitle: "Approve this airline operator?",
      confirmBody:
        `Grants <span class="mono">AIRLINE_ROLE</span> to <span class="mono">${UI.escapeHtml(wallet)}</span>. ` +
        "That wallet can then create and publish flights. Approval never grants ticket, funds or limit powers.",
      confirmText: "Approve wallet",
      danger: false,
      button: approveBtn,
      busyLabel: "Approving…",
      success: "Airline operator approved.",
    });
    if (ok) document.getElementById("f-wallet").value = "";
  }

  async function onApprovalAction(e) {
    const btn = e.target.closest("[data-admin-action]");
    if (!btn || btn.disabled) return;
    const action = btn.dataset.adminAction;
    const wallet = btn.dataset.wallet;
    const short = UI.shortAddress(wallet, 8, 6);

    const cfg = {
      approve: {
        method: "approveAirline",
        title: `Approve ${short}?`,
        body: "Grants <span class=\"mono\">AIRLINE_ROLE</span>: the wallet can create and publish flights.",
        confirm: "Approve wallet",
        danger: false,
        success: "Airline operator approved.",
      },
      reactivate: {
        method: "reactivateAirline",
        title: `Reactivate ${short}?`,
        body: "Restores operator access for a wallet that was previously approved.",
        confirm: "Reactivate wallet",
        danger: false,
        success: "Airline operator reactivated.",
      },
      deactivate: {
        method: "deactivateAirline",
        title: `Deactivate ${short}?`,
        body:
          "Revokes operator access: no new flights and no publishing or inventory changes. " +
          "Flights already created stay on-chain and their tickets remain valid.",
        confirm: "Deactivate wallet",
        danger: true,
        success: "Airline operator deactivated.",
      },
    }[action];
    if (!cfg) return;

    await runAdminAction({
      contract: "AirlineRegistry",
      method: cfg.method,
      args: [wallet],
      confirmTitle: cfg.title,
      confirmBody: cfg.body,
      confirmText: cfg.confirm,
      danger: cfg.danger,
      button: btn,
      busyLabel: "Sending…",
      success: cfg.success,
    });
  }

  function parsePct(id) {
    const raw = document.getElementById(id).value.trim();
    if (raw === "") {
      setError(id, "Required.");
      return null;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setError(id, "Enter a number.");
      return null;
    }
    if (n < 0 || n > 100) {
      setError(id, "Between 0% and 100%.");
      return null;
    }
    if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-9) {
      setError(id, "Use at most 2 decimal places.");
      return null;
    }
    return n;
  }

  function onLimitsSubmit(e) {
    e.preventDefault();
    clearErrors();
    const royaltyPct = parsePct("f-royalty-cap");
    const refundPct = parsePct("f-refund-cap");
    if (royaltyPct == null || refundPct == null) {
      const firstBad = limitsForm.querySelector('[aria-invalid="true"]');
      if (firstBad) firstBad.focus();
      return;
    }
    const royaltyBps = Math.round(royaltyPct * 100);
    const refundBps = Math.round(refundPct * 100);

    runAdminAction({
      contract: "AirlineRegistry",
      method: "setLimits",
      args: [royaltyBps, refundBps],
      confirmTitle: "Save platform limits?",
      confirmBody:
        `Resale royalty cap becomes <strong>${UI.escapeHtml(UI.formatBpsToPct(royaltyBps))}</strong> and the refund cap ` +
        `<strong>${UI.escapeHtml(UI.formatBpsToPct(refundBps))}</strong>. Every flight is checked against these caps ` +
        "from now on — flights above a lowered cap cannot be resold until the cap rises again.",
      confirmText: "Save limits",
      danger: false,
      button: limitsBtn,
      busyLabel: "Saving…",
      success: "Platform limits updated.",
    });
  }

  const PAUSE_ACTIONS = {
    registry: {
      contract: "AirlineRegistry",
      pauseTitle: "Pause the platform?",
      pauseBody:
        "Blocks flight creation and publishing, ticket purchases, resale listings and buys, and every ticket transfer. " +
        "Cancellation, refunds, marking tickets used, marking flights departed and all reads stay available.",
      pauseText: "Pause platform",
      resumeTitle: "Resume the platform?",
      resumeBody: "Lifts the platform-wide pause. Booking, resale and ticket transfers become available again.",
      resumeText: "Resume platform",
      successPause: "Platform paused.",
      successResume: "Platform resumed.",
    },
    settlement: {
      contract: "TicketSettlement",
      pauseTitle: "Pause ticket bookings?",
      pauseBody: "Blocks new purchases only — cancel and refund stay available so active tickets can still be resolved.",
      pauseText: "Pause bookings",
      resumeTitle: "Resume ticket bookings?",
      resumeBody: "Lifts the settlement pause; purchases are checked against the platform pause too.",
      resumeText: "Resume bookings",
      successPause: "Bookings paused.",
      successResume: "Bookings resumed.",
    },
    marketplace: {
      contract: "TicketMarketplace",
      pauseTitle: "Pause resale?",
      pauseBody:
        "Blocks new resale listings and resale purchases. Sellers can still withdraw an existing listing, and cancel/refund stays available.",
      pauseText: "Pause resale",
      resumeTitle: "Resume resale?",
      resumeBody: "Lifts the marketplace pause; listings and resale purchases become available again.",
      resumeText: "Resume resale",
      successPause: "Resale paused.",
      successResume: "Resale resumed.",
    },
  };

  async function onPauseClick(e) {
    const btn = e.target.closest("[data-pause]");
    if (!btn || btn.disabled) return;
    const key = btn.dataset.pause;
    const cfg = PAUSE_ACTIONS[key];
    if (!cfg) return;
    const paused = key === "registry" ? platformPaused : key === "settlement" ? settlementPaused : marketplacePaused;

    await runAdminAction({
      contract: cfg.contract,
      method: paused ? "unpause" : "pause",
      args: [],
      confirmTitle: paused ? cfg.resumeTitle : cfg.pauseTitle,
      confirmBody: paused ? cfg.resumeBody : cfg.pauseBody,
      confirmText: paused ? cfg.resumeText : cfg.pauseText,
      danger: !paused,
      button: btn,
      busyLabel: paused ? "Resuming…" : "Pausing…",
      success: paused ? cfg.successResume : cfg.successPause,
    });
  }

  // ---- Wiring ----

  approveForm.addEventListener("submit", onApproveSubmit);
  limitsForm.addEventListener("submit", onLimitsSubmit);
  approvalsBody.addEventListener("click", onApprovalAction);
  pauseCard.addEventListener("click", onPauseClick);

  // Mark the limit fields as user-edited so renderLimits() cannot overwrite a live draft.
  ["f-royalty-cap", "f-refund-cap"].forEach((id) =>
    document.getElementById(id).addEventListener("input", (e) => {
      e.target.dataset.dirty = "1";
    })
  );

  [filterType, filterFlight, filterAirline, filterState].forEach((select) =>
    select.addEventListener("change", renderAudit)
  );
  document.getElementById("audit-clear").addEventListener("click", () => {
    filterType.value = "";
    filterFlight.value = "";
    filterAirline.value = "";
    filterState.value = "";
    renderAudit();
  });
  document.getElementById("audit-refresh").addEventListener("click", () => load());

  populateTypeFilter();

  let reloadTimer = null;
  Wallet.onChange(() => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 150);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", load);
  } else {
    load();
  }
})();
