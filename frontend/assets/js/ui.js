// ui.js — shared presentation helpers (DESIGN.md §2, CONVENTIONS.md §4).
// Formatting, badges, toasts, tx progress, confirm modal, revert wording, CID fingerprint.
(function () {
  "use strict";

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  function shortAddress(addr, lead = 6, tail = 4) {
    if (!addr) return "—";
    const s = String(addr);
    return s.length <= lead + tail + 1 ? s : `${s.slice(0, lead)}…${s.slice(-tail)}`;
  }

  function shortHash(hash, lead = 10, tail = 8) {
    if (!hash) return "—";
    const s = String(hash);
    return s.length <= lead + tail + 1 ? s : `${s.slice(0, lead)}…${s.slice(-tail)}`;
  }

  /// @notice ETH amount with 4+ decimals; title attribute carries exact wei (CONVENTIONS §1).
  function ethFormat(wei) {
    if (wei == null) return "—";
    try {
      const s = window.ethers.formatEther(wei);
      const [whole, frac = ""] = s.split(".");
      const padded = (frac + "000000000000000000").slice(0, 4);
      const el = document.createElement("span");
      el.textContent = `${whole}.${padded} ETH`;
      el.title = `${wei} wei`;
      el.classList.add("nowrap");
      return el.outerHTML;
    } catch {
      return String(wei);
    }
  }

  function ethText(wei) {
    if (wei == null) return "—";
    try {
      const s = window.ethers.formatEther(wei);
      const [whole, frac = ""] = s.split(".");
      return `${whole}.${(frac + "000000000000000000").slice(0, 4)}`;
    } catch {
      return String(wei);
    }
  }

  function formatBpsToPct(bps) {
    const n = Number(bps ?? 0);
    return `${(n / 100).toFixed(2)}%`;
  }

  /// @notice Local time with UTC shown in the title attribute (CONVENTIONS §1).
  function formatTimestamp(unixSeconds) {
    if (!unixSeconds) return "—";
    const d = new Date(Number(unixSeconds) * 1000);
    const local = d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const utc = d.toUTCString();
    return `<time datetime="${d.toISOString()}" title="UTC: ${escapeHtml(utc)}">${escapeHtml(local)}</time>`;
  }

  function timestampText(unixSeconds) {
    if (!unixSeconds) return "—";
    return new Date(Number(unixSeconds) * 1000).toLocaleString();
  }

  const TICKET_BADGES = {
    Issued: "badge-issued",
    Listed: "badge-listed",
    Cancelled: "badge-cancelled",
    Refunded: "badge-cancelled",
    Used: "badge-used",
    Invalid: "badge-invalid",
  };

  const TICKET_STATE_NAMES = ["Issued", "Listed", "Cancelled", "Refunded", "Used", "Invalid"];

  function statusBadge(stateName) {
    const name = String(stateName);
    const cls = TICKET_BADGES[name] || "badge-idle";
    return `<span class="badge ${cls}">${escapeHtml(name)}</span>`;
  }

  function statusBadgeFromIndex(index) {
    return statusBadge(TICKET_STATE_NAMES[Number(index)] || "Invalid");
  }

  /// @notice One display label per flight derived from on-chain flags (DESIGN.md §1.2).
  function flightLabel(flight, wasPublished) {
    if (flight.cancelled) return { text: "Cancelled", cls: "badge-cancelled" };
    if (flight.departed) return { text: "Departed", cls: "badge-departed" };
    if (flight.salesOpen) return { text: "Published", cls: "badge-published" };
    return wasPublished
      ? { text: "Paused", cls: "badge-paused" }
      : { text: "Draft", cls: "badge-draft" };
  }

  function flightBadge(flight, wasPublished) {
    const l = flightLabel(flight, wasPublished);
    return `<span class="badge ${l.cls}">${l.text}</span>`;
  }

  // ---- Toasts ----
  let toastRegion = null;
  function ensureToastRegion() {
    if (toastRegion && document.body.contains(toastRegion)) return toastRegion;
    toastRegion = document.createElement("div");
    toastRegion.className = "toast-region";
    toastRegion.setAttribute("role", "status");
    toastRegion.setAttribute("aria-live", "polite");
    document.body.appendChild(toastRegion);
    return toastRegion;
  }

  function toast(type, message, txHash) {
    const region = ensureToastRegion();
    const el = document.createElement("div");
    el.className = `toast is-${type === "success" ? "success" : type === "error" ? "error" : type === "warn" ? "warn" : "info"}`;
    const body = document.createElement("div");
    body.innerHTML = escapeHtml(message);
    if (txHash) {
      body.appendChild(document.createElement("br"));
      const link = document.createElement("span");
      link.className = "mono xsmall";
      link.textContent = `tx ${shortHash(txHash)}`;
      body.appendChild(link);
    }
    el.appendChild(body);
    const close = document.createElement("button");
    close.className = "toast-close";
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss notification");
    close.textContent = "✕";
    close.addEventListener("click", () => el.remove());
    el.appendChild(close);
    region.appendChild(el);
    const ttl = type === "error" ? 9000 : 6000;
    setTimeout(() => {
      el.classList.add("is-leaving");
      setTimeout(() => el.remove(), reducedMotion() ? 0 : 260);
    }, ttl);
    return el;
  }

  // ---- Tx progress stepper ----
  function txSteps(container, steps) {
    container.innerHTML = "";
    const list = document.createElement("ol");
    list.className = "tx-steps";
    steps.forEach((label) => {
      const li = document.createElement("li");
      li.textContent = label;
      list.appendChild(li);
    });
    container.appendChild(list);
    return {
      set(index, state) {
        const li = list.children[index];
        if (li) li.className = `is-${state}`;
        // Everything before a done/error marker that is still idle becomes done.
        for (let i = 0; i < index; i += 1) {
          if (!list.children[i].className.includes("error")) {
            list.children[i].className = "is-done";
          }
        }
      },
      fail(index, message) {
        this.set(index, "error");
        if (message) toast("error", message);
      },
      node: list,
    };
  }

  // ---- Empty state ----
  function emptyRow(tbody, colSpan, message) {
    tbody.innerHTML = `<tr><td colspan="${colSpan}" class="empty-state">${escapeHtml(message)}</td></tr>`;
  }

  // ---- Confirm modal (focus moved in, restored on close, ESC closes) ----
  function confirmModal({ title, body, confirmText = "Confirm", danger = false }) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <h3 id="modal-title">${escapeHtml(title)}</h3>
          <div class="modal-body">${body}</div>
          <div class="modal-actions">
            <button type="button" class="btn" data-role="cancel">Cancel</button>
            <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-role="ok">${escapeHtml(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);
      const ok = backdrop.querySelector('[data-role="ok"]');
      const cancel = backdrop.querySelector('[data-role="cancel"]');
      ok.focus();

      function close(result) {
        document.removeEventListener("keydown", onKey);
        const finish = () => {
          backdrop.remove();
          if (previous && previous.focus) previous.focus();
          resolve(result);
        };
        if (reducedMotion()) {
          finish();
          return;
        }
        backdrop.classList.add("is-closing");
        setTimeout(finish, 170);
      }
      function onKey(e) {
        if (e.key === "Escape") close(false);
        if (e.key === "Tab") {
          const focusables = [cancel, ok];
          const idx = focusables.indexOf(document.activeElement);
          e.preventDefault();
          const next = e.shiftKey
            ? focusables[(idx + focusables.length - 1) % focusables.length]
            : focusables[(idx + 1) % focusables.length];
          next.focus();
        }
      }
      ok.addEventListener("click", () => close(true));
      cancel.addEventListener("click", () => close(false));
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) close(false);
      });
      document.addEventListener("keydown", onKey);
    });
  }

  // ---- Revert reason → human wording (CONVENTIONS §3) ----
  const REVERT_TEXT = {
    PlatformPaused__: "The platform is paused by the administrator. Try again after it is unpaused.",
    NotAdmin__caller: "Only the platform administrator can do that.",
    PaymentMismatch__value: "The payment must exactly match the fare or the listed resale price.",
    EmptyCid__: "Ticket metadata is missing an upload reference.",
    InvalidCid__: "The metadata reference (CID) is not in a valid format.",
    SalesOpen__closed: "Sales are closed for this flight (draft or paused).",
    FlightCancelled__id: "This flight was cancelled.",
    FlightDeparted__id: "This flight has already departed.",
    NoSeatsAvailable__id: "No seats are left on this flight.",
    UnknownFlight__id: "That flight does not exist.",
    UnknownTicket__id: "That ticket does not exist.",
    UnauthorizedAirline__caller: "This wallet is not an approved airline operator.",
    NotFlightAirline__caller: "Only the airline that owns this flight can do that.",
    UnauthorizedSettlement__caller: "This action can only run through the settlement contract.",
    DirectTransferBlocked__: "Tickets can only move through the approved marketplace.",
    NotIssued__state: "Only an issued ticket allows that action.",
    TerminalState__state: "This ticket is in a final state.",
    CheckinClosed__now: "Check-in for this ticket has not opened yet.",
    InventoryFull__id: "All seats are already back in inventory.",
    AlreadyDeparted__id: "This flight has already departed.",
    AlreadyCancelled__id: "This flight is already cancelled.",
    PastDeparture__time: "Departure time must be in the future.",
    ZeroCapacity__: "Seat capacity must be at least 1.",
    InvalidRefundDeadline__deadline: "The refund deadline cannot be after departure.",
    RefundRateTooHigh__bps: "Refund rate cannot exceed 100%.",
    RoyaltyAboveCap__bps: "Royalty is above the platform's current resale royalty cap.",
    RoyaltyCapTooHigh__bps: "A platform cap cannot be set above 100% (10000 basis points).",
    RefundCapTooHigh__bps: "A platform cap cannot be set above 100% (10000 basis points).",
    ZeroAddress__wallet: "The zero address cannot be used here.",
    DuplicateFlightCode__code: "That flight code is already in use.",
    AlreadyApproved__wallet: "That wallet is already an approved airline.",
    NotApproved__wallet: "That wallet is not an approved airline.",
    UnauthorizedCaller__caller: "This action is restricted to the settlement and marketplace contracts.",
    AccessControlUnauthorizedAccount: "Your wallet does not have permission for this action.",
    UnknownListing__id: "That listing does not exist.",
    ListingNotActive__id: "That listing has already been sold or withdrawn.",
    ListingExpired__expiresAt: "That listing has expired and can no longer be bought.",
    NotSeller__caller: "Only the wallet that created this listing can withdraw it.",
    AlreadyListed__tokenId: "This ticket is already listed for resale.",
    InvalidState__state: "This ticket is not in a state that allows that action.",
    SellerMismatch__seller: "The ticket is no longer owned by the wallet that listed it.",
    ResaleCapExceeded__price: "The asking price may not exceed 120% of the original fare.",
    ExpiryPastCheckin__expiresAt: "A listing must expire at least 2 hours before departure.",
    ExpiryInPast__expiresAt: "The listing expiry must be in the future.",
    ZeroPrice__: "Enter a resale price greater than zero.",
    NotTicketOwner__caller: "Only the wallet that owns this ticket can do that.",
    RefundDeadlinePassed__deadline: "The refund deadline for this ticket has passed.",
    NothingToWithdraw__: "There is no withdrawable revenue for this wallet yet.",
    RefundNotCovered__: "This balance is still reserved for possible ticket refunds.",
    TransferFailed__receiver: "The refund transfer could not be delivered.",
  };

  function revertMessage(err, contracts) {
    const data =
      [err?.data, err?.error?.data, err?.info?.error?.data, err?.value?.data].find(
        (d) => typeof d === "string" && d.startsWith("0x") && d.length >= 10
      ) || null;
    if (data && contracts) {
      for (const c of contracts) {
        try {
          const parsed = c.interface.parseError(data);
          if (parsed) {
            const text = REVERT_TEXT[parsed.name];
            if (text) return text;
            const args = parsed.args.map(String).join(", ");
            return `${humanizeName(parsed.name)} (${args})`;
          }
        } catch {
          /* try the next interface */
        }
      }
    }
    const msg = err?.shortMessage || err?.message || String(err);
    // shortMessage is generic for custom errors ("unknown custom error"); the decoded
    // name lives in message, so scan both before falling back to wording rules.
    const haystack = `${msg} ${err?.message || ""}`;
    for (const [name, text] of Object.entries(REVERT_TEXT)) {
      if (haystack.includes(name)) return text;
    }
    if (/user (rejected|denied)/i.test(msg)) return "Transaction was rejected in the wallet.";
    if (/insufficient funds/i.test(msg)) return "This wallet does not have enough test ETH.";
    if (/could not coalesce|failed to fetch|network/i.test(msg)) {
      return "Cannot reach the local chain — is the Hardhat node running?";
    }
    return msg.length > 220 ? `${msg.slice(0, 220)}…` : msg;
  }

  function humanizeName(name) {
    return String(name)
      .replace(/__.*$/, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ");
  }

  // ---- Metadata fingerprint (FR-18 demo integrity check, non-cryptographic) ----
  // FNV-1a 64-bit over the exact payload bytes; stored inside the metadata as
  // `fingerprint` (appended last) so any device can re-verify retrieved content.
  function fingerprint(text) {
    const FNV_OFFSET = 0xcbf29ce484222325n;
    const FNV_PRIME = 0x100000001b3n;
    const MASK = 0xffffffffffffffffn;
    let hash = FNV_OFFSET;
    const s = String(text);
    for (let i = 0; i < s.length; i += 1) {
      hash ^= BigInt(s.charCodeAt(i) & 0xff);
      hash = (hash * FNV_PRIME) & MASK;
      hash ^= BigInt(s.charCodeAt(i) >>> 8);
      hash = (hash * FNV_PRIME) & MASK;
    }
    return hash.toString(16).padStart(16, "0");
  }

  /// @notice Deterministic mock CID used only when the upload endpoint is unreachable
  ///         (D-05). The `mock` prefix is what the wallet renders as `mock fallback`.
  function mockCidFor(text) {
    const a = fingerprint(text);
    const b = fingerprint(`${text}|salt`);
    return `mock${a}${b}`;
  }

  function cidSource(cid) {
    return String(cid || "").startsWith("mock") ? "mock fallback" : "IPFS";
  }

  function sourceBadge(cid) {
    const source = cidSource(cid);
    const cls = source === "IPFS" ? "badge-info" : "badge-warn";
    return `<span class="badge ${cls}">${source}</span>`;
  }

  // ---- Public CID verification (FR-18) — shared by the wallet and the verifier page ----
  function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  /// @notice Re-derive the fingerprint from retrieved metadata and compare with the on-chain CID.
  /// @param cid Metadata CID recorded on the ticket.
  /// @returns {Promise<{cls: string, text: string}>} badge class + human wording.
  async function verifyCid(cid) {
    if (String(cid).startsWith("mock")) {
      return {
        cls: "tick-warn",
        text: "metadata was stored locally at purchase, so there is nothing to fetch from IPFS",
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
      const recomputed = fingerprint(JSON.stringify(copy));
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

  // ---- QR deep link (D-21: vendored qrcode-generator 2.0.4, MIT; no external service) ----
  /// @notice PNG data URL for `verify.html?ticketId=…`; null when the vendor bundle is absent.
  function qrDataUrl(text, cellSize = 4, margin = 2) {
    if (typeof window.qrcode !== "function") return null;
    try {
      const qr = window.qrcode(0, "M"); // 0 = smallest type that fits the payload
      qr.addData(String(text));
      qr.make();
      return qr.createDataURL(cellSize, margin);
    } catch (err) {
      console.warn("QR generation failed", err);
      return null;
    }
  }

  /// @notice Verification deep link for a ticket (canonical form used by cards and QR codes).
  function verifyLink(tokenId) {
    return `verify.html?ticketId=${encodeURIComponent(String(tokenId))}`;
  }

  // ---- Transaction history renderer (DESIGN §6 `txHistory`) ----
  function txHistoryRows(rows, emptyMessage, colSpan = 4) {
    if (!rows || rows.length === 0) {
      return `<tr><td colspan="${colSpan}" class="empty-state">${escapeHtml(emptyMessage)}</td></tr>`;
    }
    return rows
      .map(
        (r) => `
        <tr>
          <td data-label="Time">${r.time}</td>
          <td data-label="Event">${r.badge}</td>
          <td data-label="Summary">${r.details}</td>
          <td data-label="Transaction"><span class="mono xsmall">${escapeHtml(shortHash(r.hash))}</span></td>
        </tr>`
      )
      .join("");
  }

  // ---- Pending-phase links (pages that arrive in later phases must not 404) ----
  function bindPendingLinks(root = document) {
    root.querySelectorAll("[data-phase]").forEach((el) => {
      if (el.dataset.bound === "1") return;
      el.dataset.bound = "1";
      el.addEventListener("click", (e) => {
        e.preventDefault();
        toast("warn", `${el.textContent.trim()} arrives in ${el.dataset.phase} of this prototype.`);
      });
    });
  }

  // ---- Verify deep links (clean-URL redirect drops `?ticketId=`) ----
  /// @notice Stash the ticket ID of any `verify.html?ticketId=N` anchor before navigation,
  /// so the verifier page can restore it after the server rewrites the URL to `/verify`.
  function bindVerifyHandoff(root = document) {
    if (root.dataset && root.dataset.verifyHandoff === "1") return;
    if (root.dataset) root.dataset.verifyHandoff = "1";
    root.addEventListener("click", (e) => {
      const anchor =
        e.target && e.target.closest ? e.target.closest('a[href*="verify.html"]') : null;
      if (!anchor) return;
      const match = /[?&]ticketId=([^&#]+)/.exec(anchor.getAttribute("href") || "");
      if (match) sessionStorage.setItem("verify.ticket", decodeURIComponent(match[1]));
    });
  }

  // ---- Motion + loading skeletons ----
  function reducedMotion() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function markBusy(el) {
    if (el) el.setAttribute("aria-busy", "true");
  }

  function clearBusy(el) {
    if (el) el.removeAttribute("aria-busy");
  }

  /// @notice Shimmering placeholders shaped like a flight/listing card.
  function skeletonCards(container, count = 3) {
    if (!container) return;
    markBusy(container);
    container.innerHTML = Array.from({ length: count }, () => `
      <article class="sk-card" aria-hidden="true">
        <div class="sk-row">
          <div class="skeleton sk-line sk-tall sk-40"></div>
          <div class="skeleton sk-chip"></div>
        </div>
        <div class="skeleton sk-line sk-tall sk-70"></div>
        <div class="sk-stack tight">
          <div class="skeleton sk-line sk-60"></div>
          <div class="skeleton sk-line sk-50"></div>
          <div class="skeleton sk-line sk-70"></div>
        </div>
        <div class="skeleton sk-bar"></div>
        <div class="sk-row push">
          <div class="skeleton sk-line sk-tall sk-30"></div>
          <div class="skeleton sk-btn"></div>
        </div>
      </article>`).join("");
  }

  /// @notice Shimmering placeholders shaped like the boarding-pass ticket card.
  function skeletonTickets(container, count = 2) {
    if (!container) return;
    markBusy(container);
    container.innerHTML = Array.from({ length: count }, () => `
      <div class="sk-ticket" aria-hidden="true">
        <div class="sk-main">
          <div class="sk-row">
            <div class="skeleton sk-line sk-tall sk-40"></div>
            <div class="skeleton sk-chip"></div>
          </div>
          <div class="skeleton sk-line sk-tall sk-50"></div>
          <div class="sk-stack tight">
            <div class="skeleton sk-line sk-40"></div>
            <div class="skeleton sk-line sk-70"></div>
            <div class="skeleton sk-line sk-50"></div>
          </div>
          <div class="skeleton sk-90 sk-bar"></div>
        </div>
        <div class="sk-stub">
          <div class="skeleton sk-seat"></div>
          <div class="skeleton sk-line sk-90"></div>
        </div>
      </div>`).join("");
  }

  /// @notice One shimmer bar per cell for a loading table body.
  function skeletonRows(tbody, cols = 4, rows = 5) {
    if (!tbody) return;
    markBusy(tbody);
    const widths = ["sk-90", "sk-70", "sk-60", "sk-80", "sk-50"];
    tbody.innerHTML = Array.from({ length: rows }, () => `
      <tr class="skeleton-row" aria-hidden="true">
        ${Array.from({ length: cols }, (_, i) =>
          `<td><div class="skeleton sk-line ${widths[i % widths.length]}"></div></td>`
        ).join("")}
      </tr>`).join("");
  }

  /// @notice Text-line placeholders for a panel that has not resolved yet.
  function skeletonLines(container, count = 4) {
    if (!container) return;
    markBusy(container);
    container.innerHTML = `
      <div class="sk-stack">
        ${Array.from({ length: count }, (_, i) =>
          `<div class="skeleton sk-line ${i % 3 === 2 ? "sk-60" : i % 2 === 1 ? "sk-90" : ""}"></div>`
        ).join("")}
      </div>`;
  }

  /// @notice Same, wrapped in a card-like panel (used where content sits directly on the page).
  function skeletonPanel(container, count = 4) {
    if (!container) return;
    markBusy(container);
    container.innerHTML = `
      <div class="sk-panel">
        <div class="sk-stack">
          ${Array.from({ length: count }, (_, i) =>
            `<div class="skeleton sk-line ${i % 3 === 2 ? "sk-60" : i % 2 === 1 ? "sk-90" : ""}"></div>`
          ).join("")}
        </div>
      </div>`;
  }

  /// @notice Swap a stat row into (or out of) its shimmering loading state.
  function statsLoading(row, on) {
    if (!row) return;
    row.querySelectorAll(".stat").forEach((s) => s.classList.toggle("is-loading", Boolean(on)));
    if (on) {
      row.hidden = false;
      markBusy(row);
    } else {
      clearBusy(row);
    }
  }

  /// @notice One-time entrance reveal for the blocks of a page. Skips when the browser
  ///         cannot observe intersection or the user prefers reduced motion.
  function initMotion() {
    const main = document.querySelector("main");
    if (!main || typeof window.IntersectionObserver !== "function" || reducedMotion()) return;

    const targets = Array.from(main.children).filter((el) => el.offsetHeight > 0);
    if (targets.length === 0) return;

    document.documentElement.classList.add("js-motion");
    targets.forEach((el, i) => {
      el.classList.add("reveal");
      el.style.setProperty("--reveal-i", String(Math.min(i, 5)));
    });

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        });
      },
      { threshold: 0.05, rootMargin: "0px 0px -32px 0px" }
    );
    targets.forEach((el) => io.observe(el));

    // Safety net: never leave content hidden if the observer never fires.
    setTimeout(() => {
      targets.forEach((el) => {
        el.classList.add("is-visible");
        io.unobserve(el);
      });
    }, 3000);
  }

  // Replace native browser dropdown popups with an accessible, themed menu.
  // The original select stays in the DOM so existing page code can continue to
  // read `.value` and listen for `change` events without any changes.
  function initCustomSelects(root = document) {
    root.querySelectorAll("select:not([data-custom-select])").forEach((select) => {
      select.dataset.customSelect = "true";
      const wrapper = document.createElement("div");
      wrapper.className = "select-control";
      select.parentNode.insertBefore(wrapper, select);
      wrapper.appendChild(select);
      select.classList.add("select-native");

      const button = document.createElement("button");
      button.type = "button";
      button.className = "select-trigger";
      button.setAttribute("aria-haspopup", "listbox");
      button.setAttribute("aria-expanded", "false");
      wrapper.appendChild(button);

      const menu = document.createElement("div");
      menu.className = "select-menu";
      menu.setAttribute("role", "listbox");
      wrapper.appendChild(menu);

      function close() {
        wrapper.classList.remove("is-open");
        button.setAttribute("aria-expanded", "false");
      }

      function render() {
        const selected = select.options[select.selectedIndex];
        button.textContent = selected ? selected.textContent : "Select…";
        button.disabled = select.disabled;
        menu.innerHTML = "";
        Array.from(select.options).forEach((option) => {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "select-option";
          item.textContent = option.textContent;
          item.dataset.value = option.value;
          item.setAttribute("role", "option");
          item.setAttribute("aria-selected", String(option.selected));
          item.disabled = option.disabled;
          item.addEventListener("click", () => {
            select.value = option.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            close();
            button.focus();
          });
          menu.appendChild(item);
        });
      }

      button.addEventListener("click", () => {
        if (select.disabled) return;
        const open = wrapper.classList.toggle("is-open");
        button.setAttribute("aria-expanded", String(open));
      });
      select.addEventListener("change", render);
      new MutationObserver(render).observe(select, { childList: true, subtree: true, attributes: true });
      render();
    });

    if (!document.documentElement.dataset.selectDismissBound) {
      document.documentElement.dataset.selectDismissBound = "true";
      document.addEventListener("click", (event) => {
        document.querySelectorAll(".select-control.is-open").forEach((wrapper) => {
          if (!wrapper.contains(event.target)) {
            wrapper.classList.remove("is-open");
            wrapper.querySelector(".select-trigger")?.setAttribute("aria-expanded", "false");
          }
        });
      });
    }
  }

  // The native calendar/time popup is drawn by the OS and cannot be styled, so
  // every date field gets this themed popover instead. The original input stays
  // in the DOM with its id, name, YYYY-MM-DDTHH:mm value and `input`/`change`
  // events unchanged, so existing form code needs no modification.
  function initCustomDateTimes(root = document) {
    const selector =
      'input[type="datetime-local"]:not([data-custom-datetime]), input[type="date"]:not([data-custom-datetime])';

    root.querySelectorAll(selector).forEach((input) => {
      input.dataset.customDatetime = "true";
      const withTime = input.type !== "date";

      const wrapper = document.createElement("div");
      wrapper.className = "datetime-control";
      input.parentNode.insertBefore(wrapper, input);
      wrapper.appendChild(input);
      input.classList.add("datetime-native");
      input.tabIndex = -1;

      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "datetime-trigger";
      trigger.setAttribute("aria-haspopup", "dialog");
      trigger.setAttribute("aria-expanded", "false");
      wrapper.appendChild(trigger);

      const popup = document.createElement("div");
      popup.className = "datetime-popover";
      popup.setAttribute("role", "dialog");
      popup.setAttribute("aria-hidden", "true");
      popup.innerHTML = `
        <div class="datetime-head"><button type="button" class="datetime-prev" aria-label="Previous month">&#8249;</button><strong class="datetime-month"></strong><button type="button" class="datetime-next" aria-label="Next month">&#8250;</button></div>
        <div class="datetime-week"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div>
        <div class="datetime-days"></div>
        ${withTime ? `<div class="datetime-time"><label>Time</label><div class="datetime-time-options"></div></div>` : ""}
        <div class="datetime-actions"><button type="button" class="datetime-today">Today</button><button type="button" class="datetime-clear">Clear</button><button type="button" class="datetime-done">Done</button></div>`;
      wrapper.appendChild(popup);

      const monthLabel = popup.querySelector(".datetime-month");
      const days = popup.querySelector(".datetime-days");
      const timeOptions = popup.querySelector(".datetime-time-options");
      const now = new Date();

      // Parse the contract value ourselves: new Date("YYYY-MM-DD") is read as
      // UTC, which shifts a day in negative-offset timezones.
      function parseValue(value) {
        const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value || "");
        if (!match) return null;
        const date = new Date(
          +match[1],
          +match[2] - 1,
          +match[3],
          withTime ? +match[4] : 0,
          withTime ? +match[5] : 0,
          0,
          0
        );
        return Number.isNaN(date.getTime()) ? null : date;
      }

      function formatValue(date) {
        const pad = (n) => String(n).padStart(2, "0");
        const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
        return withTime ? `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
      }

      function formatDisplay(value) {
        const date = parseValue(value);
        if (!date) return withTime ? "Select date & time" : "Select a date";
        return withTime
          ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
          : date.toLocaleDateString(undefined, { dateStyle: "medium" });
      }

      let selected = parseValue(input.value);
      let view = selected
        ? new Date(selected.getFullYear(), selected.getMonth(), 1)
        : new Date(now.getFullYear(), now.getMonth(), 1);

      // Everything that can change the field — user picks, form.reset(), or page
      // code assigning .value — lands here so the visible text never goes stale.
      function sync() {
        trigger.textContent = formatDisplay(input.value);
        trigger.classList.toggle("is-placeholder", !input.value);
      }

      function commit() {
        input.value = selected ? formatValue(selected) : "";
        sync();
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }

      function render() {
        monthLabel.textContent = view.toLocaleDateString(undefined, { month: "long", year: "numeric" });
        days.innerHTML = "";
        const start = view.getDay();
        const count = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
        for (let i = 0; i < start; i += 1) days.appendChild(document.createElement("span"));
        for (let day = 1; day <= count; day += 1) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "datetime-day";
          button.textContent = String(day);
          if (
            selected &&
            selected.getFullYear() === view.getFullYear() &&
            selected.getMonth() === view.getMonth() &&
            selected.getDate() === day
          ) {
            button.classList.add("is-selected");
          } else if (
            day === now.getDate() &&
            view.getFullYear() === now.getFullYear() &&
            view.getMonth() === now.getMonth()
          ) {
            button.classList.add("is-today");
          }
          button.addEventListener("click", () => {
            const base = selected || new Date();
            selected = new Date(view.getFullYear(), view.getMonth(), day, base.getHours(), base.getMinutes(), 0, 0);
            commit();
            render();
          });
          days.appendChild(button);
        }
        if (!timeOptions) return;
        timeOptions.innerHTML = "";
        for (let hour = 0; hour < 24; hour += 1) {
          for (let minute = 0; minute < 60; minute += 15) {
            const option = document.createElement("button");
            option.type = "button";
            option.textContent = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
            if (selected && selected.getHours() === hour && selected.getMinutes() === minute) {
              option.classList.add("is-selected");
            }
            option.addEventListener("click", () => {
              const base = selected || new Date();
              selected = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
              commit();
              render();
            });
            timeOptions.appendChild(option);
          }
        }
      }

      // Keep the popover inside the viewport: flip horizontally near the right
      // edge, flip vertically to the roomier side, and cap the height to what is
      // actually left on screen. The sticky navbar is excluded from the "above"
      // budget because the card's reveal transform traps the popover in a lower
      // stacking context, so it would slide out of sight behind it.
      function position() {
        popup.style.left = "";
        popup.style.right = "";
        popup.style.maxHeight = "";
        days.style.maxHeight = "";
        days.style.overflowY = "";
        popup.classList.remove("is-up");
        const doc = document.documentElement;
        const rect = wrapper.getBoundingClientRect();
        if (rect.left + popup.offsetWidth + 12 > doc.clientWidth) {
          popup.style.left = "auto";
          popup.style.right = "0";
        }
        const navbar = document.querySelector(".navbar");
        const navbarBottom = navbar ? navbar.getBoundingClientRect().bottom : 0;
        const stickyTop = navbarBottom > 0 ? navbarBottom : 0;
        const height = popup.offsetHeight;
        const spaceBelow = doc.clientHeight - rect.bottom;
        const spaceAbove = rect.top - stickyTop;
        const up = spaceBelow < height + 12 && spaceAbove > spaceBelow;
        if (up) popup.classList.add("is-up");
        const available = (up ? spaceAbove : spaceBelow) - 12;
        // Scroll only the day grid when vertical room runs out, so the month
        // header and the Today/Clear/Done row stay on screen.
        if (available > 140 && available < height) {
          const trimmed = Math.max(72, days.offsetHeight - (height - available));
          days.style.maxHeight = `${Math.floor(trimmed)}px`;
          days.style.overflowY = "auto";
        }
      }

      wrapper.dtPosition = position;

      function open() {
        wrapper.classList.add("is-open");
        trigger.setAttribute("aria-expanded", "true");
        popup.setAttribute("aria-hidden", "false");
        render();
        position();
      }

      function close() {
        if (!wrapper.classList.contains("is-open")) return;
        wrapper.classList.remove("is-open");
        trigger.setAttribute("aria-expanded", "false");
        popup.setAttribute("aria-hidden", "true");
      }

      trigger.addEventListener("click", () => {
        if (input.disabled) return;
        if (wrapper.classList.contains("is-open")) close();
        else open();
      });
      popup.querySelector(".datetime-prev").addEventListener("click", () => {
        view.setMonth(view.getMonth() - 1);
        render();
      });
      popup.querySelector(".datetime-next").addEventListener("click", () => {
        view.setMonth(view.getMonth() + 1);
        render();
      });
      popup.querySelector(".datetime-today").addEventListener("click", () => {
        const today = new Date();
        const base = selected || new Date();
        selected = new Date(today.getFullYear(), today.getMonth(), today.getDate(), base.getHours(), base.getMinutes(), 0, 0);
        view = new Date(selected.getFullYear(), selected.getMonth(), 1);
        commit();
        render();
      });
      popup.querySelector(".datetime-clear").addEventListener("click", () => {
        selected = null;
        commit();
        close();
        trigger.focus();
      });
      popup.querySelector(".datetime-done").addEventListener("click", () => {
        close();
        trigger.focus();
      });

      const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (valueDescriptor && valueDescriptor.get && valueDescriptor.set) {
        Object.defineProperty(input, "value", {
          configurable: true,
          get() {
            return valueDescriptor.get.call(this);
          },
          set(next) {
            valueDescriptor.set.call(this, next);
            sync();
          },
        });
      }

      input.addEventListener("input", sync);
      input.addEventListener("change", () => {
        selected = parseValue(input.value);
        sync();
      });
      // Any click that reaches the hidden input (label activation, showPicker())
      // would raise the OS popup, so route both back to this popover.
      input.addEventListener("click", (event) => event.preventDefault());
      input.showPicker = () => {
        if (!input.disabled && !input.readOnly) open();
      };

      const form = input.form;
      if (form) {
        form.addEventListener("reset", () => {
          setTimeout(() => {
            selected = parseValue(input.value);
            sync();
          }, 0);
        });
      }

      const label = input.id
        ? Array.from(document.querySelectorAll("label")).find((el) => el.htmlFor === input.id)
        : null;
      if (label) {
        label.classList.add("datetime-label");
        label.addEventListener("click", (event) => {
          event.preventDefault();
          if (input.disabled) return;
          if (wrapper.classList.contains("is-open")) close();
          else {
            open();
            trigger.focus();
          }
        });
      }

      sync();
    });

    if (!document.documentElement.dataset.datetimeDismissBound) {
      document.documentElement.dataset.datetimeDismissBound = "true";
      document.addEventListener("mousedown", (event) => {
        if (event.target && event.target.closest && event.target.closest(".datetime-control")) return;
        document.querySelectorAll(".datetime-control.is-open").forEach((control) => {
          control.classList.remove("is-open");
          control.querySelector(".datetime-trigger")?.setAttribute("aria-expanded", "false");
          control.querySelector(".datetime-popover")?.setAttribute("aria-hidden", "true");
        });
      });
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        const open = document.querySelector(".datetime-control.is-open");
        if (!open) return;
        open.classList.remove("is-open");
        open.querySelector(".datetime-trigger")?.setAttribute("aria-expanded", "false");
        open.querySelector(".datetime-popover")?.setAttribute("aria-hidden", "true");
        open.querySelector(".datetime-trigger")?.focus();
      });
      window.addEventListener("resize", () => {
        document.querySelectorAll(".datetime-control.is-open").forEach((control) => {
          if (typeof control.dtPosition === "function") control.dtPosition();
        });
      });
    }
  }

  // ---- Misc ----
  function setBusy(button, busy, label) {
    if (busy) {
      button.dataset.originalHtml = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${label ? escapeHtml(label) : escapeHtml(button.textContent.trim())}`;
    } else {
      button.disabled = false;
      if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
      delete button.dataset.originalHtml;
    }
  }

  function localInputToUnix(value) {
    if (!value) return 0;
    const d = new Date(value);
    return Math.floor(d.getTime() / 1000);
  }

  function unixToLocalInput(unixSeconds) {
    const d = new Date(Number(unixSeconds) * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  window.UI = {
    escapeHtml,
    shortAddress,
    shortHash,
    ethFormat,
    ethText,
    formatBpsToPct,
    formatTimestamp,
    timestampText,
    statusBadge,
    statusBadgeFromIndex,
    flightLabel,
    flightBadge,
    toast,
    txSteps,
    emptyRow,
    confirmModal,
    revertMessage,
    fingerprint,
    mockCidFor,
    cidSource,
    sourceBadge,
    verifyCid,
    qrDataUrl,
    verifyLink,
    txHistoryRows,
    bindPendingLinks,
    bindVerifyHandoff,
    setBusy,
    localInputToUnix,
    unixToLocalInput,
    reducedMotion,
    skeletonCards,
    skeletonTickets,
    skeletonRows,
    skeletonLines,
    skeletonPanel,
    statsLoading,
    markBusy,
    clearBusy,
    initMotion,
    initCustomSelects,
    initCustomDateTimes,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initMotion();
      initCustomSelects();
      initCustomDateTimes();
      new MutationObserver(() => { initCustomSelects(); initCustomDateTimes(); }).observe(document.body, { childList: true, subtree: true });
    });
  } else {
    initMotion();
    initCustomSelects();
    initCustomDateTimes();
    new MutationObserver(() => { initCustomSelects(); initCustomDateTimes(); }).observe(document.body, { childList: true, subtree: true });
  }
})();
