// airline.html — flight creation (FR-08 client validation + on-chain re-checks),
// inventory actions: publish / pause sales / cancel / mark departed, revenue
// withdrawal (available = credited - refund escrow, D-20) and Phase 4 resale
// royalty metrics (ListingSold events whose flight belongs to this wallet).
(function () {
  "use strict";

  const notices = document.getElementById("page-notices");
  const statsRow = document.getElementById("stats-row");
  const createCard = document.getElementById("create-card");
  const pausedWarning = document.getElementById("paused-warning");
  const inventoryBody = document.getElementById("inventory-body");
  const bookingsBody = document.getElementById("bookings-body");
  const resultCount = document.getElementById("result-count");
  const inventoryHint = document.getElementById("inventory-hint");
  const form = document.getElementById("create-form");
  const createBtn = document.getElementById("create-btn");
  const withdrawCard = document.getElementById("withdraw-card");
  const wdCredited = document.getElementById("wd-credited");
  const wdReserved = document.getElementById("wd-reserved");
  const wdAvailable = document.getElementById("wd-available");
  const withdrawBtn = document.getElementById("withdraw-btn");
  const withdrawHint = document.getElementById("withdraw-hint");
  const withdrawResult = document.getElementById("withdraw-result");
  const resaleBody = document.getElementById("resale-body");
  const resaleHint = document.getElementById("resale-hint");
  const statResales = document.getElementById("stat-resales");
  const statRoyalty = document.getElementById("stat-royalty");
  const statResaleGross = document.getElementById("stat-resale-gross");

  let approved = false;
  let platformPaused = false;
  let ownFlights = [];
  let accruedWei = 0n;
  let reservedWei = 0n;
  let availableWei = 0n;
  let limits = { maxRoyaltyBps: 1000, maxRefundBps: 10000 };
  let loading = false;
  let withdrawing = false;

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
    ["f-code", "f-origin", "f-dest", "f-departure", "f-seats", "f-price", "f-refund-deadline", "f-refund-pct", "f-royalty-pct"]
      .forEach((id) => setError(id, ""));
  }

  async function validateForm() {
    clearErrors();
    const values = {
      code: document.getElementById("f-code").value.trim(),
      origin: document.getElementById("f-origin").value.trim().toUpperCase(),
      destination: document.getElementById("f-dest").value.trim().toUpperCase(),
      departure: UI.localInputToUnix(document.getElementById("f-departure").value),
      seats: Number(document.getElementById("f-seats").value),
      priceText: document.getElementById("f-price").value,
      refundDeadline: UI.localInputToUnix(document.getElementById("f-refund-deadline").value),
      refundPct: Number(document.getElementById("f-refund-pct").value),
      royaltyPct: Number(document.getElementById("f-royalty-pct").value),
    };

    let ok = true;
    const fail = (id, msg) => {
      setError(id, msg);
      ok = false;
    };

    if (!/^[A-Za-z0-9-]{2,12}$/.test(values.code)) {
      fail("f-code", "2–12 letters, digits, or dashes.");
    }
    if (!/^[A-Z]{3}$/.test(values.origin)) fail("f-origin", "Use a 3-letter code, e.g. DAC.");
    if (!/^[A-Z]{3}$/.test(values.destination)) fail("f-dest", "Use a 3-letter code, e.g. DXB.");
    if (values.origin === values.destination) fail("f-dest", "Destination must differ from origin.");
    if (!values.departure || values.departure <= Math.floor(Date.now() / 1000)) {
      fail("f-departure", "Departure must be in the future.");
    }
    if (!Number.isInteger(values.seats) || values.seats < 1) fail("f-seats", "At least 1 whole seat.");
    let priceWei = null;
    try {
      priceWei = ethers.parseEther(values.priceText || "0");
      if (priceWei <= 0n) fail("f-price", "Price must be greater than 0.");
    } catch {
      fail("f-price", "Enter a valid ETH amount.");
    }
    if (!values.refundDeadline) {
      fail("f-refund-deadline", "Required.");
    } else if (values.departure && values.refundDeadline > values.departure) {
      fail("f-refund-deadline", "Cannot be after departure.");
    }
    if (!(values.refundPct >= 0 && values.refundPct <= Number(limits.maxRefundBps) / 100)) {
      fail("f-refund-pct", `0–${Number(limits.maxRefundBps) / 100}%.`);
    }
    if (!(values.royaltyPct >= 0 && values.royaltyPct <= Number(limits.maxRoyaltyBps) / 100)) {
      fail("f-royalty-pct", `0–${Number(limits.maxRoyaltyBps) / 100}% (platform cap).`);
    }

    if (ok) {
      // Duplicate flight-code check against the chain (codes reusable only after cancellation).
      try {
        const inventory = Wallet.read("FlightInventory");
        const hash = ethers.keccak256(ethers.toUtf8Bytes(values.code));
        const existingId = Number(await inventory.codeToFlightId(hash));
        if (existingId !== 0) {
          const existing = await inventory.getFlight(existingId);
          if (!existing.cancelled) {
            fail("f-code", `Code already used by flight #${existingId}.`);
          }
        }
      } catch (err) {
        console.warn("duplicate-code check failed", err);
      }
    }

    if (!ok) {
      const firstBad = form.querySelector('[aria-invalid="true"]');
      if (firstBad) firstBad.focus();
      return null;
    }
    return values;
  }

  async function onCreate(e) {
    e.preventDefault();
    const values = await validateForm();
    if (!values) return;
    if (!(await Wallet.requireWrite())) return;

    UI.setBusy(createBtn, true, "Creating…");
    try {
      const inventory = await Wallet.write("FlightInventory");
      const tx = await inventory.createFlight([
        values.code,
        values.origin,
        values.destination,
        values.departure,
        values.seats,
        ethers.parseEther(values.priceText),
        values.refundDeadline,
        Math.round(values.refundPct * 100),
        Math.round(values.royaltyPct * 100),
      ]);
      const receipt = await tx.wait();
      let flightId = null;
      for (const log of receipt.logs) {
        try {
          const parsed = inventory.interface.parseLog(log);
          if (parsed && parsed.name === "FlightCreated") {
            flightId = Number(parsed.args.flightId);
            break;
          }
        } catch {
          /* not an inventory log */
        }
      }
      UI.toast(
        "success",
        `Flight ${values.code} created${flightId ? ` as #${flightId}` : ""} — publish it to open sales.`,
        receipt.hash
      );
      form.reset();
      document.getElementById("f-seats").value = "30";
      document.getElementById("f-price").value = "0.05";
      document.getElementById("f-refund-pct").value = "80";
      document.getElementById("f-royalty-pct").value = "8";
      await load();
    } catch (err) {
      console.error(err);
      UI.toast("error", UI.revertMessage(err, Wallet.allContracts()));
    } finally {
      UI.setBusy(createBtn, false);
    }
  }

  // ---- Inventory actions ----

  function actionButtons(f) {
    const id = Number(f.flightId);
    const buttons = [];
    if (!f.salesOpen && !f.departed && !f.cancelled) {
      buttons.push(`<button type="button" class="btn btn-sm btn-primary" data-action="publish" data-flight="${id}">Publish</button>`);
    }
    if (f.salesOpen) {
      buttons.push(`<button type="button" class="btn btn-sm" data-action="pause" data-flight="${id}">Pause sales</button>`);
    }
    if (!f.departed && !f.cancelled) {
      buttons.push(`<button type="button" class="btn btn-sm" data-action="depart" data-flight="${id}">Mark departed</button>`);
      buttons.push(`<button type="button" class="btn btn-sm btn-danger" data-action="cancel" data-flight="${id}">Cancel</button>`);
    }
    if (buttons.length === 0) {
      return `<span class="xsmall muted">${f.cancelled ? "Final" : "No actions"}</span>`;
    }
    return buttons.join("");
  }

  async function onActionClick(e) {
    const btn = e.target.closest("[data-action]");
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action;
    const flightId = Number(btn.dataset.flight);
    const flight = ownFlights.find((f) => Number(f.flightId) === flightId);
    if (!flight) return;

    const labels = {
      publish: {
        title: `Publish flight ${flight.flightCode}?`,
        body: "Sales open immediately: travelers can book seats at the listed fare.",
        confirm: "Publish flight",
        method: "publishFlight",
        danger: false,
      },
      pause: {
        title: `Pause sales for ${flight.flightCode}?`,
        body: "New bookings stop; existing tickets are unaffected. You can publish again later.",
        confirm: "Pause sales",
        method: "pauseSales",
        danger: false,
      },
      cancel: {
        title: `Cancel flight ${flight.flightCode}?`,
        body: "This is terminal: the flight closes permanently (codes become reusable). Ticket refunds arrive in Phase 3.",
        confirm: "Cancel flight",
        method: "cancelFlight",
        danger: true,
      },
      depart: {
        title: `Mark ${flight.flightCode} departed?`,
        body: "Sales close and cancellations/resale become ineligible. Only do this after the flight has actually departed.",
        confirm: "Mark departed",
        method: "markDeparted",
        danger: false,
      },
    };
    const cfg = labels[action];
    if (!cfg) return;

    const confirmed = await UI.confirmModal({
      title: cfg.title,
      body: `<p>${UI.escapeHtml(cfg.body)}</p>`,
      confirmText: cfg.confirm,
      danger: cfg.danger,
    });
    if (!confirmed) return;
    if (!(await Wallet.requireWrite())) return;

    UI.setBusy(btn, true);
    try {
      const inventory = await Wallet.write("FlightInventory");
      const tx = await inventory[cfg.method](flightId);
      const receipt = await tx.wait();
      UI.toast("success", `${cfg.confirm} — confirmed.`, receipt.hash);
      await load();
    } catch (err) {
      console.error(err);
      UI.toast("error", UI.revertMessage(err, Wallet.allContracts()));
      UI.setBusy(btn, false);
    }
  }

  // ---- Rendering ----

  function renderStats() {
    const seatsSold = ownFlights.reduce(
      (sum, f) => sum + (Number(f.seatCapacity) - Number(f.seatsAvailable)),
      0
    );
    document.getElementById("stat-flights").textContent = String(ownFlights.length);
    document.getElementById("stat-seats").textContent = String(seatsSold);
    document.getElementById("stat-accrued").innerHTML = UI.ethFormat(accruedWei);
    document.getElementById("stat-approval").innerHTML = approved
      ? '<span class="badge badge-ok">Approved</span>'
      : '<span class="badge badge-idle">Pending</span>';
    statsRow.hidden = false;
    renderWithdraw();
  }

  // ---- Revenue withdrawal (per-airline pull, D-11; escrow withheld, D-20) ----

  function renderWithdraw() {
    availableWei = accruedWei > reservedWei ? accruedWei - reservedWei : 0n;
    wdCredited.innerHTML = UI.ethFormat(accruedWei);
    wdReserved.innerHTML = UI.ethFormat(reservedWei);
    wdAvailable.innerHTML = UI.ethFormat(availableWei);
    withdrawCard.hidden = false;

    if (availableWei > 0n) {
      withdrawBtn.disabled = false;
      withdrawBtn.title = "";
      withdrawHint.textContent =
        "Pays the available balance to this wallet. Reserved refunds stay in the contract.";
    } else {
      withdrawBtn.disabled = true;
      withdrawBtn.title = "Nothing to withdraw";
      withdrawHint.textContent =
        accruedWei > 0n
          ? "Everything credited is still reserved for possible ticket refunds."
          : "No revenue has accrued for this wallet yet.";
    }
  }

  async function onWithdraw() {
    if (withdrawing || availableWei === 0n) return;
    const confirmed = await UI.confirmModal({
      title: "Withdraw accrued revenue?",
      body:
        `<p>You will receive <strong>${UI.ethText(availableWei)} ETH</strong> of available revenue.` +
        ` ${UI.ethText(reservedWei)} ETH stays reserved so ticket refunds remain fundable.</p>` +
        `<p class="xsmall muted mb-0">Only this wallet's own balance can be withdrawn.</p>`,
      confirmText: "Withdraw revenue",
      danger: false,
    });
    if (!confirmed) return;
    if (!(await Wallet.requireWrite())) return;

    withdrawing = true;
    UI.setBusy(withdrawBtn, true, "Withdrawing…");
    withdrawResult.hidden = true;
    try {
      const settlement = await Wallet.write("TicketSettlement");
      const tx = await settlement.withdrawAirlineBalance();
      const receipt = await tx.wait();
      if (receipt.status !== 1) throw new Error("transaction reverted");

      let amount = availableWei;
      for (const log of receipt.logs) {
        try {
          const parsed = settlement.interface.parseLog(log);
          if (parsed && parsed.name === "AirlineWithdrawn") amount = parsed.args.amount;
        } catch {
          /* log from another contract */
        }
      }

      withdrawResult.hidden = false;
      withdrawResult.innerHTML = `
        <div class="notice notice-success" aria-live="polite">
          <div class="row"><strong>Withdrew ${UI.escapeHtml(UI.ethText(amount))} ETH.</strong>
            <span class="badge badge-ok">Confirmed</span></div>
          <div class="tx-hash mt-3">${UI.escapeHtml(receipt.hash)}</div>
        </div>`;
      UI.toast("success", `Withdrew ${UI.ethText(amount)} ETH.`, receipt.hash);
      await load();
    } catch (err) {
      console.error("withdrawal failed", err);
      UI.toast("error", UI.revertMessage(err, Wallet.allContracts()));
    } finally {
      withdrawing = false;
      UI.setBusy(withdrawBtn, false);
      renderWithdraw();
    }
  }

  function renderInventory() {
    resultCount.textContent = `${ownFlights.length} flight${ownFlights.length === 1 ? "" : "s"}`;
    inventoryHint.textContent = approved
      ? "Contract re-checks every action on-chain."
      : "Read-only until this wallet is approved.";
    if (ownFlights.length === 0) {
      inventoryBody.innerHTML =
        '<tr><td colspan="7" class="empty-state">' +
        (approved
          ? "No flights yet — create the first one above."
          : "No flights for this wallet. Airline approval is required before creating flights.") +
        "</td></tr>";
      return;
    }
    inventoryBody.innerHTML = ownFlights
      .map((f) => {
        const sold = Number(f.seatCapacity) - Number(f.seatsAvailable);
        const gross = BigInt(sold) * BigInt(f.priceWei);
        return `
          <tr>
            <td data-label="Code"><span class="mono">${UI.escapeHtml(f.flightCode)}</span> <span class="xsmall muted">#${Number(f.flightId)}</span></td>
            <td data-label="Route">${UI.escapeHtml(f.origin)} → ${UI.escapeHtml(f.destination)}</td>
            <td data-label="Departure">${UI.formatTimestamp(f.departureTime)}</td>
            <td data-label="Seats">${sold}/${Number(f.seatCapacity)}</td>
            <td data-label="Gross booked">${UI.ethFormat(gross)}</td>
            <td data-label="State">${UI.flightBadge(f, true)}</td>
            <td class="actions" data-label="Actions">${actionButtons(f)}</td>
          </tr>`;
      })
      .join("");
  }

  async function renderBookings() {
    if (ownFlights.length === 0) {
      bookingsBody.innerHTML =
        '<tr><td colspan="6" class="empty-state">No bookings yet.</td></tr>';
      return;
    }
    try {
      const settlement = Wallet.read("TicketSettlement");
      const ownIds = new Set(ownFlights.map((f) => Number(f.flightId)));
      const perFlight = await Promise.all(
        [...ownIds].map((id) =>
          settlement.queryFilter(settlement.filters.PurchaseCompleted(id)).catch(() => [])
        )
      );
      const events = perFlight.flat().sort((a, b) => b.blockNumber - a.blockNumber).slice(0, 50);
      if (events.length === 0) {
        bookingsBody.innerHTML =
          '<tr><td colspan="6" class="empty-state">No bookings yet.</td></tr>';
        return;
      }
      const blockNumbers = [...new Set(events.map((e) => e.blockNumber))];
      const blocks = await Promise.all(
        blockNumbers.map((bn) => settlement.runner.provider.getBlock(bn).catch(() => null))
      );
      const timeByBlock = new Map(
        blockNumbers.map((bn, i) => [bn, blocks[i] ? blocks[i].timestamp : null])
      );
      bookingsBody.innerHTML = events
        .map((e) => {
          const flightId = Number(e.args.flightId);
          const flight = ownFlights.find((f) => Number(f.flightId) === flightId);
          const ts = timeByBlock.get(e.blockNumber);
          return `
            <tr>
              <td data-label="Time">${ts ? UI.formatTimestamp(ts) : `block ${e.blockNumber}`}</td>
              <td data-label="Flight">${UI.escapeHtml(flight ? flight.flightCode : `#${flightId}`)}</td>
              <td data-label="Ticket">#${Number(e.args.tokenId)}</td>
              <td data-label="Buyer"><span class="mono">${UI.shortAddress(e.args.buyer)}</span></td>
              <td data-label="Fare">${flight ? UI.ethFormat(flight.priceWei) : "—"}</td>
              <td data-label="Transaction"><span class="mono xsmall">${UI.shortHash(e.transactionHash)}</span></td>
            </tr>`;
        })
        .join("");
    } catch (err) {
      console.error(err);
      bookingsBody.innerHTML =
        '<tr><td colspan="6" class="empty-state">Could not load booking events.</td></tr>';
    }
  }

  // ---- Phase 4: resale royalties paid straight to this wallet (FR-10, sibling rule §5.4) ----

  function renderResaleEmpty(message) {
    resaleBody.innerHTML = `<tr><td colspan="7" class="empty-state">${UI.escapeHtml(message)}</td></tr>`;
    statResales.textContent = "0";
    statRoyalty.textContent = UI.ethFormat(0n);
    statResaleGross.textContent = UI.ethFormat(0n);
  }

  async function renderResales(address) {
    if (ownFlights.length === 0) {
      renderResaleEmpty("No resales on your flights yet.");
      return;
    }
    try {
      const marketplace = Wallet.read("TicketMarketplace");
      const nft = Wallet.read("AirTicketNFT");
      const inventory = Wallet.read("FlightInventory");

      const sold = await marketplace
        .queryFilter(marketplace.filters.ListingSold())
        .catch(() => []);
      if (sold.length === 0) {
        renderResaleEmpty("No resales on your flights yet.");
        return;
      }

      // ListingSold does not carry the airline, so resolve listing → ticket → flight.
      const ownIds = new Set(ownFlights.map((f) => Number(f.flightId)));
      const mine = [];
      for (const e of sold) {
        try {
          const listing = await marketplace.getListing(Number(e.args.listingId));
          const ticket = await nft.getTicket(listing.tokenId);
          if (!ownIds.has(Number(ticket.flightId))) continue;
          mine.push({ e, listing, ticket });
        } catch {
          /* listing or ticket no longer resolvable */
        }
      }

      if (mine.length === 0) {
        renderResaleEmpty("No resales on your flights yet.");
        return;
      }

      mine.sort((a, b) => b.e.blockNumber - a.e.blockNumber);
      let royaltyTotal = 0n;
      let grossTotal = 0n;
      mine.forEach(({ e }) => {
        royaltyTotal += e.args.royalty;
        grossTotal += e.args.priceWei;
      });
      statResales.textContent = String(mine.length);
      statRoyalty.innerHTML = UI.ethFormat(royaltyTotal);
      statResaleGross.innerHTML = UI.ethFormat(grossTotal);
      resaleHint.textContent =
        `${mine.length} settled resale${mine.length === 1 ? "" : "s"} · royalty paid directly to this wallet`;

      const blockNumbers = [...new Set(mine.map(({ e }) => e.blockNumber))];
      const blocks = await Promise.all(
        blockNumbers.map((bn) => marketplace.runner.provider.getBlock(bn).catch(() => null))
      );
      const timeByBlock = new Map(
        blockNumbers.map((bn, i) => [bn, blocks[i] ? blocks[i].timestamp : null])
      );

      resaleBody.innerHTML = mine
        .map(({ e, ticket }) => {
          const ts = timeByBlock.get(e.blockNumber);
          return `
            <tr>
              <td data-label="Time">${ts ? UI.formatTimestamp(ts) : `block ${e.blockNumber}`}</td>
              <td data-label="Ticket">#${Number(e.args.tokenId)} <span class="mono xsmall">${UI.escapeHtml(ticket.seatReference)}</span></td>
              <td data-label="Buyer"><span class="mono">${UI.shortAddress(e.args.buyer)}</span></td>
              <td data-label="Sale price">${UI.ethFormat(e.args.priceWei)}</td>
              <td data-label="Royalty">${UI.ethFormat(e.args.royalty)}</td>
              <td data-label="Seller received">${UI.ethFormat(e.args.sellerProceeds)}</td>
              <td data-label="Transaction"><span class="mono xsmall">${UI.shortHash(e.transactionHash)}</span></td>
            </tr>`;
        })
        .join("");
    } catch (err) {
      console.error(err);
      renderResaleEmpty("Could not load resale royalty events.");
    }
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
        createCard.hidden = true;
        statsRow.hidden = true;
        withdrawCard.hidden = true;
        inventoryBody.innerHTML = '<tr><td colspan="7" class="empty-state">Contracts not loaded.</td></tr>';
        bookingsBody.innerHTML = '<tr><td colspan="6" class="empty-state">Contracts not loaded.</td></tr>';
        renderResaleEmpty("Contracts not loaded.");
        return;
      }
      if (!Wallet.hasInjectedWallet() || !Wallet.state.address) {
        setNotice(
          '<div class="notice"><strong>Connect your wallet</strong> to see your flights and create new ones. ' +
            '<button type="button" class="btn btn-primary btn-sm" id="inline-connect">Connect wallet</button></div>'
        );
        const inline = document.getElementById("inline-connect");
        if (inline) inline.addEventListener("click", () => Wallet.connect());
        createCard.hidden = true;
        statsRow.hidden = true;
        withdrawCard.hidden = true;
        inventoryBody.innerHTML = '<tr><td colspan="7" class="empty-state">Wallet not connected.</td></tr>';
        bookingsBody.innerHTML = '<tr><td colspan="6" class="empty-state">Wallet not connected.</td></tr>';
        renderResaleEmpty("Wallet not connected.");
        return;
      }
      if (!Wallet.isSupportedChain()) {
        setNotice(
          `<div class="notice notice-warn"><strong>Wrong network.</strong> Switch to Hardhat chain ${Wallet.expectedChainId()}. ` +
            '<button type="button" class="btn btn-sm" id="inline-switch">Switch network</button></div>'
        );
        const sw = document.getElementById("inline-switch");
        if (sw) sw.addEventListener("click", () => Wallet.ensureChain());
        createCard.hidden = true;
        withdrawCard.hidden = true;
        return;
      }

      const address = Wallet.state.address;
      const registry = Wallet.read("AirlineRegistry");
      const inventory = Wallet.read("FlightInventory");
      const settlement = Wallet.read("TicketSettlement");

      [platformPaused, approved, limits.maxRoyaltyBps, limits.maxRefundBps] = await Promise.all([
        registry.paused().catch(() => false),
        registry.isApproved(address),
        registry.maxRoyaltyBps(),
        registry.maxRefundBps(),
      ]);
      [accruedWei, reservedWei] = await Promise.all([
        settlement.airlineBalances(address).catch(() => 0n),
        settlement.refundReserve(address).catch(() => 0n),
      ]);

      const noticesHtml = [];
      if (platformPaused) {
        noticesHtml.push(
          '<div class="notice notice-warn"><strong>Platform paused.</strong> ' +
            "Create and publish are blocked; pause/cancel/depart remain available so active flights can be resolved.</div>"
        );
      }
      if (!approved) {
        const isAdmin = Wallet.state.role === "admin";
        noticesHtml.push(
          `<div class="notice notice-info"><strong>Wallet not approved as an airline operator.</strong> ` +
            `Ask the platform administrator to approve <span class="mono">${UI.shortAddress(address, 10, 8)}</span>` +
            `${isAdmin ? " (you are the administrator — approvals arrive in Phase 5; approve via the test setup for now)" : ""}. ` +
            "Flight creation requires on-chain approval.</div>"
        );
      }
      setNotice(noticesHtml.join(""));
      pausedWarning.hidden = !platformPaused;

      // Own flights (enumerate; prototype scale is small).
      const nextId = Number(await inventory.nextFlightId());
      const all = [];
      for (let id = 1; id < nextId; id += 1) {
        try {
          const f = await inventory.getFlight(id);
          if (f.airline.toLowerCase() === address.toLowerCase()) all.push(f);
        } catch {
          /* skip */
        }
      }
      ownFlights = all.sort((a, b) => Number(b.flightId) - Number(a.flightId));

      createCard.hidden = !approved;
      renderStats();
      renderInventory();
      await renderBookings();
      await renderResales(address);
    } catch (err) {
      console.error(err);
      setNotice(
        '<div class="notice notice-danger"><strong>Could not load airline data.</strong> ' +
          UI.escapeHtml(UI.revertMessage(err, Wallet.allContracts())) +
          " Is the Hardhat node running?</div>"
      );
    } finally {
      loading = false;
    }
  }

  // ---- Wiring ----

  form.addEventListener("submit", onCreate);
  inventoryBody.addEventListener("click", onActionClick);
  withdrawBtn.addEventListener("click", onWithdraw);

  // Default the refund deadline to the chosen departure time.
  document.getElementById("f-departure").addEventListener("change", () => {
    const dep = document.getElementById("f-departure").value;
    const dl = document.getElementById("f-refund-deadline");
    if (dep && (!dl.value || UI.localInputToUnix(dl.value) > UI.localInputToUnix(dep))) {
      dl.value = dep;
    }
  });

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
