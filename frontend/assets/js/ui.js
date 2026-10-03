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
    setTimeout(() => el.remove(), type === "error" ? 9000 : 6000);
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
        backdrop.remove();
        if (previous && previous.focus) previous.focus();
        resolve(result);
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
    RoyaltyAboveCap__bps: "Royalty exceeds the platform cap of 10%.",
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
          <td data-label="Details">${r.details}</td>
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
    setBusy,
    localInputToUnix,
    unixToLocalInput,
  };
})();
