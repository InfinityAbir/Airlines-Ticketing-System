// flights.html — list published flights with live inventory (DESIGN.md §3.2).
(function () {
  "use strict";

  const grid = document.getElementById("flights-grid");
  const resultCount = document.getElementById("result-count");
  const notices = document.getElementById("page-notices");

  let flights = [];
  let published = new Set();
  let platformPaused = false;
  let loading = false;

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

  async function load() {
    if (loading) return;
    loading = true;
    resultCount.textContent = "Loading…";
    try {
      if (Wallet.configMissing()) {
        showConfigNotice();
        return;
      }
      const inventory = Wallet.read("FlightInventory");
      const registry = Wallet.read("AirlineRegistry");

      platformPaused = await registry.paused();

      const nextId = Number(await inventory.nextFlightId());
      const ids = [];
      for (let id = 1; id < nextId; id += 1) ids.push(id);

      const [loaded, publishedEvents] = await Promise.all([
        Promise.all(
          ids.map((id) =>
            inventory.getFlight(id).then(
              (f) => f,
              () => null
            )
          )
        ),
        inventory
          .queryFilter(inventory.filters.FlightPublished())
          .catch(() => []),
      ]);
      published = new Set(publishedEvents.map((e) => Number(e.args.flightId)));
      flights = loaded.filter(Boolean);

      if (platformPaused) {
        setNotice(
          '<div class="notice notice-warn"><strong>Platform paused.</strong> ' +
            "The administrator has paused the platform: you can browse, but booking is disabled until it is unpaused.</div>"
        );
      } else {
        setNotice("");
      }
      render();
    } catch (err) {
      console.error(err);
      setNotice(
        '<div class="notice notice-danger"><strong>Could not load flights.</strong> ' +
          UI.escapeHtml(UI.revertMessage(err, Wallet.allContracts())) +
          " Is the Hardhat node running?</div>"
      );
      resultCount.textContent = "—";
    } finally {
      loading = false;
    }
  }

  function bookable(f) {
    if (!f.salesOpen || f.cancelled || f.departed) return false;
    if (Number(f.seatsAvailable) === 0) return false;
    if (platformPaused) return false;
    return true;
  }

  function blockedReason(f) {
    if (f.cancelled) return "This flight was cancelled.";
    if (f.departed) return "This flight has already departed.";
    if (!f.salesOpen) return "Sales are not open for this flight yet.";
    if (Number(f.seatsAvailable) === 0) return "All seats are booked.";
    if (platformPaused) return "The platform is paused — booking is temporarily disabled.";
    return "";
  }

  function cardHtml(f) {
    const id = Number(f.flightId);
    const capacity = Number(f.seatCapacity);
    const available = Number(f.seatsAvailable);
    const sold = capacity - available;
    const pct = capacity > 0 ? Math.round((sold / capacity) * 100) : 0;
    const badge = UI.flightBadge(f, published.has(id));
    const can = bookable(f);
    const refundPct = (Number(f.refundBps) / 100).toFixed(0);
    const royaltyPct = (Number(f.royaltyBps) / 100).toFixed(1).replace(/\.0$/, "");

    return `
      <article class="flight-card${can ? "" : " is-disabled"}">
        <div class="flight-head">
          <span class="flight-code">${UI.escapeHtml(f.flightCode)}</span>
          ${badge}
        </div>
        <div class="route">${UI.escapeHtml(f.origin)}
          <span class="arrow" aria-hidden="true">→</span>
          <span class="sr-only">to</span>${UI.escapeHtml(f.destination)}</div>
        <div class="flight-meta">
          <span><span class="label">Departure</span><br>${UI.formatTimestamp(f.departureTime)}</span>
          <span><span class="label">Operator</span><br><span class="mono">${UI.shortAddress(f.airline)}</span></span>
          <span><span class="label">Refund policy</span><br>${refundPct}% until ${UI.formatTimestamp(f.refundDeadline)}</span>
          <span><span class="label">Resale royalty</span><br>${royaltyPct}% to operator</span>
        </div>
        <div>
          <div class="seat-bar" title="${sold} of ${capacity} seats booked">
            <span style="width:${pct}%"></span>
          </div>
          <div class="xsmall muted mt-3">${sold} of ${capacity} seats booked · ${available} available</div>
        </div>
        <div class="flight-foot">
          <span class="price">${UI.ethFormat(f.priceWei)}</span>
          <button type="button" class="btn btn-primary" data-select="${id}"${can ? "" : ` disabled title="${UI.escapeHtml(blockedReason(f))}"`}>
            ${can ? "Select seat" : "Unavailable"}
          </button>
        </div>
      </article>`;
  }

  function applyFilters(list) {
    const origin = document.getElementById("filter-origin").value.trim().toUpperCase();
    const dest = document.getElementById("filter-dest").value.trim().toUpperCase();
    const date = document.getElementById("filter-date").value;
    return list.filter((f) => {
      if (origin && !String(f.origin).toUpperCase().includes(origin)) return false;
      if (dest && !String(f.destination).toUpperCase().includes(dest)) return false;
      if (date) {
        const d = new Date(Number(f.departureTime) * 1000);
        const pad = (n) => String(n).padStart(2, "0");
        const localDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        if (localDate !== date) return false;
      }
      return true;
    });
  }

  function render() {
    const visible = applyFilters(flights);
    resultCount.textContent =
      `${visible.length} flight${visible.length === 1 ? "" : "s"}` +
      (visible.length !== flights.length ? ` (of ${flights.length} total)` : "");

    if (visible.length === 0) {
      grid.innerHTML =
        '<div class="notice empty-state" style="grid-column:1/-1">' +
        (flights.length === 0
          ? "No flights on chain yet. An airline operator creates the first one from the Airline page."
          : "No flights match these filters.") +
        "</div>";
      return;
    }
    grid.innerHTML = visible.map(cardHtml).join("");
  }

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-select]");
    if (!btn || btn.disabled) return;
    window.location.href = `checkout.html?flight=${btn.dataset.select}`;
  });

  ["filter-origin", "filter-dest", "filter-date"].forEach((id) => {
    document.getElementById(id).addEventListener("input", () => render());
  });
  document.getElementById("filter-clear").addEventListener("click", () => {
    document.getElementById("filter-origin").value = "";
    document.getElementById("filter-dest").value = "";
    document.getElementById("filter-date").value = "";
    render();
  });
  document.getElementById("refresh-btn").addEventListener("click", load);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", load);
  } else {
    load();
  }
  Wallet.onChange(() => {});
})();
