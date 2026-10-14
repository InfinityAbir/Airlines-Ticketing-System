// wallet.js — connect, chain guard (FR-01/02/03), role detection, contract instances.
// Role routing here is convenience only: every privileged write re-checks on-chain (FR-04).
(function () {
  "use strict";

  const HARDHAT_HEX = "0x7a69"; // 31337
  const HARDHAT_PARAMS = {
    chainId: HARDHAT_HEX,
    chainName: "Hardhat Local (31337)",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["http://127.0.0.1:8545"],
  };

  const config = window.CONTRACTS_CONFIG || null;
  const state = {
    address: null,
    chainId: null,
    role: "guest",
    connecting: false,
    provider: null,
    signer: null,
  };
  // A wallet may expose previously approved accounts through `eth_accounts`.
  // Treat those as signed out until the person explicitly chooses Login here.
  let appSessionActive = sessionStorage.getItem("airline-wallet-session") === "true";
  const listeners = [];
  let initStarted = false;
  // Resolves after the first refresh() settles so pages can gate on address/chain without racing.
  let readyResolve;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });

  function notify() {
    listeners.forEach((fn) => {
      try {
        fn(state);
      } catch (err) {
        console.error("wallet listener failed", err);
      }
    });
    renderChrome();
  }

  function onChange(fn) {
    listeners.push(fn);
    return () => listeners.splice(listeners.indexOf(fn), 1);
  }

  function hasInjectedWallet() {
    return Boolean(window.ethereum);
  }

  function configMissing() {
    return !config || !config.addresses || !config.abis;
  }

  function expectedChainId() {
    return config ? Number(config.chainId) : null;
  }

  function isSupportedChain() {
    if (!config || state.chainId == null) return false;
    return Number(state.chainId) === Number(config.chainId);
  }

  function read(name) {
    if (configMissing()) throw new Error("contracts-config.js missing — run the deploy script first.");
    // Public pages (flights, marketplace, checkout preview) are readable without a
    // wallet, so fall back to the plain JSON-RPC provider when none is injected.
    if (!hasInjectedWallet() || !window.ethereum) return readPublic(name);
    if (!state.provider) state.provider = new ethers.BrowserProvider(window.ethereum, "any");
    return new ethers.Contract(config.addresses[name], config.abis[name], state.provider);
  }

  // Wallet-less read path (FR-31: the public verifier needs no injected wallet).
  let publicProvider = null;
  function readPublic(name) {
    if (configMissing()) throw new Error("contracts-config.js missing — run the deploy script first.");
    if (!publicProvider) {
      publicProvider = new ethers.JsonRpcProvider(
        APP_CONFIG.rpcUrl,
        Number(config.chainId),
        { cacheTimeout: -1 }
      );
    }
    return new ethers.Contract(config.addresses[name], config.abis[name], publicProvider);
  }

  async function write(name) {
    if (configMissing()) throw new Error("contracts-config.js missing — run the deploy script first.");
    if (!hasInjectedWallet()) throw new Error("No EVM wallet detected in this browser.");
    if (!state.signer) {
      state.provider = new ethers.BrowserProvider(window.ethereum, "any");
      state.signer = await state.provider.getSigner();
    }
    return new ethers.Contract(config.addresses[name], config.abis[name], state.signer);
  }

  function allContracts() {
    if (configMissing()) return [];
    if (!state.provider && hasInjectedWallet()) {
      state.provider = new ethers.BrowserProvider(window.ethereum, "any");
    }
    if (!state.provider) return [];
    return Object.keys(config.addresses).map((name) =>
      new ethers.Contract(config.addresses[name], config.abis[name], state.provider)
    );
  }

  async function refresh() {
    if (!appSessionActive) {
      state.address = null;
      state.chainId = null;
      state.signer = null;
      state.role = "guest";
      notify();
      return;
    }
    if (!hasInjectedWallet() || configMissing()) {
      state.address = null;
      state.chainId = null;
      state.role = "guest";
      notify();
      return;
    }
    try {
      state.provider = new ethers.BrowserProvider(window.ethereum, "any");
      const accounts = await window.ethereum.request({ method: "eth_accounts" });
      state.address = accounts && accounts.length ? ethers.getAddress(accounts[0]) : null;
      if (!state.address) {
        appSessionActive = false;
        sessionStorage.removeItem("airline-wallet-session");
      }
      const net = await state.provider.getNetwork();
      state.chainId = Number(net.chainId);
      state.signer = state.address ? await state.provider.getSigner() : null;
      state.role = await detectRole(state.address);
    } catch (err) {
      console.error("wallet refresh failed", err);
      state.address = null;
      state.role = "guest";
    }
    notify();
  }

  async function detectRole(address) {
    if (!address || configMissing()) return "guest";
    try {
      const registry = read("AirlineRegistry");
      const adminRole = await registry.DEFAULT_ADMIN_ROLE();
      if (await registry.hasRole(adminRole, address)) return "admin";
      if (await registry.isApproved(address)) return "airline";
    } catch (err) {
      console.error("role detection failed", err);
    }
    return "traveler";
  }

  async function connect() {
    if (!hasInjectedWallet()) {
      window.UI.toast("error", "No injected wallet found. Install MetaMask (or a compatible wallet) to continue.");
      return false;
    }
    if (configMissing()) {
      window.UI.toast("error", "Contract configuration is missing. Run `npm run deploy` first.");
      return false;
    }
    state.connecting = true;
    notify();
    try {
      state.provider = new ethers.BrowserProvider(window.ethereum, "any");
      await window.ethereum.request({ method: "eth_requestAccounts" });
      appSessionActive = true;
      sessionStorage.setItem("airline-wallet-session", "true");
      await refresh();
      await ensureChain(true);
      return Boolean(state.address);
    } catch (err) {
      window.UI.toast("error", window.UI.revertMessage(err, allContracts()));
      return false;
    } finally {
      state.connecting = false;
      notify();
    }
  }

  function logout() {
    appSessionActive = false;
    sessionStorage.removeItem("airline-wallet-session");
    state.address = null;
    state.chainId = null;
    state.signer = null;
    state.role = "guest";
    notify();
    window.UI.toast("info", "You are signed out of this app. MetaMask remains connected in your browser.");
  }

  /// @notice Switch the wallet to the configured chain; add it if unknown (FR-03).
  async function ensureChain(silent = false) {
    if (!hasInjectedWallet() || configMissing()) return false;
    if (isSupportedChain()) return true;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: HARDHAT_HEX }],
      });
      await refresh();
      return isSupportedChain();
    } catch (err) {
      if (err && (err.code === 4902 || err.code === -32603)) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [HARDHAT_PARAMS],
          });
          await refresh();
          return isSupportedChain();
        } catch (addErr) {
          if (!silent) {
            window.UI.toast("error", "Could not add the Hardhat network to your wallet.");
          }
          return false;
        }
      }
      if (!silent) {
        window.UI.toast(
          "warn",
          `Switch your wallet to Hardhat chain ${expectedChainId()} (local node) to continue.`
        );
      }
      return false;
    }
  }

  /// @notice Guard for any write path: connected + supported chain (CONVENTIONS §4).
  async function requireWrite() {
    if (configMissing()) {
      window.UI.toast("error", "Contract configuration is missing. Run `npm run deploy` first.");
      return false;
    }
    if (!hasInjectedWallet()) {
      window.UI.toast("error", "No injected wallet detected. Install MetaMask to continue.");
      return false;
    }
    if (!state.address) {
      const ok = await connect();
      if (!ok) return false;
    }
    if (!isSupportedChain()) {
      const switched = await ensureChain();
      if (!switched) {
        window.UI.toast(
          "error",
          `Wrong network. This prototype only writes on chain ${expectedChainId()} (Hardhat).`
        );
        return false;
      }
    }
    if (!state.signer) {
      state.signer = await state.provider.getSigner();
    }
    return true;
  }

  const ROLE_LABELS = {
    guest: "Guest",
    traveler: "Traveler",
    airline: "Airline Operator",
    admin: "Administrator",
  };

  function renderChrome() {
    const isAuthenticated = Boolean(state.address);
    document.querySelectorAll('[data-role="connect"], [data-role="login"]').forEach((connectBtn) => {
      if (state.connecting) {
        connectBtn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Connecting…';
        connectBtn.disabled = true;
      } else {
        connectBtn.disabled = false;
        connectBtn.textContent = connectBtn.dataset.role === "login" ? "Login with MetaMask" : state.address ? window.UI.shortAddress(state.address) : "Connect wallet";
        connectBtn.title = state.address ? state.address : "Open MetaMask to sign in";
        if (connectBtn.dataset.role === "login") {
          connectBtn.toggleAttribute("hidden", isAuthenticated);
        }
      }
    });

    document.querySelectorAll('[data-role="logout"]').forEach((logoutBtn) => {
      logoutBtn.toggleAttribute("hidden", !isAuthenticated);
      logoutBtn.title = state.address ? `Sign out ${window.UI.shortAddress(state.address)}` : "Sign out";
    });

    const roleChip = document.querySelector('[data-role="role"]');
    if (roleChip) {
      roleChip.textContent = ROLE_LABELS[state.role] || "Guest";
    }

    // Navbar visibility (role-based routing as convenience only — every privileged
    // write re-checks on-chain, FR-04):
    //   Flights / Marketplace / Verify        public (FR-31: the verifier needs no wallet)
    //   My Tickets                            any connected wallet
    //   Airline                               airline operator or administrator
    //   Admin Console                         administrator only
    document
      .querySelectorAll('.nav-links a[href="tickets.html"]')
      .forEach((link) => link.closest("li").toggleAttribute("hidden", !isAuthenticated));
    document
      .querySelectorAll('.nav-links a[href="airline.html"]')
      .forEach((link) =>
        link.closest("li").toggleAttribute("hidden", state.role !== "airline" && state.role !== "admin")
      );
    document
      .querySelectorAll('.nav-links a[href="admin.html"]')
      .forEach((link) => link.closest("li").toggleAttribute("hidden", state.role !== "admin"));

    const networkPill = document.querySelector('[data-role="network"]');
    if (networkPill) {
      if (configMissing()) {
        networkPill.className = "pill pill-danger";
        networkPill.textContent = "No contract config";
      } else if (state.address == null) {
        networkPill.className = "pill pill-idle";
        networkPill.textContent = `Expected chain ${config.chainId}`;
      } else if (isSupportedChain()) {
        networkPill.className = "pill pill-ok";
        networkPill.textContent = `Hardhat ${config.chainId}`;
      } else {
        networkPill.className = "pill pill-danger";
        networkPill.textContent = `Unsupported chain ${state.chainId}`;
      }
    }

    const networkLine = document.querySelector('[data-role="network-line"]');
    if (networkLine) {
      if (configMissing()) {
        networkLine.innerHTML = '<span class="text-danger">Contract configuration unavailable</span>';
      } else {
        const chain = `Hardhat ${config.chainId}`;
        const wallet = state.address
          ? `Wallet ${window.UI.shortAddress(state.address)}`
          : "Wallet not connected";
        const status = isSupportedChain()
          ? '<span class="text-ok">Writes enabled</span>'
          : state.address
            ? '<span class="text-danger">Switch network</span>'
            : "Writes blocked";
        networkLine.innerHTML = `<span>${chain}</span><span class="network-separator">·</span><span>${wallet}</span><span class="network-separator">·</span>${status}`;
      }
    }
  }

  function init() {
    if (initStarted) return;
    initStarted = true;

    document.querySelectorAll('[data-role="connect"], [data-role="login"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.dataset.role === "login") {
          await connect();
          return;
        }
        if (state.address) {
          try {
            await navigator.clipboard.writeText(state.address);
            window.UI.toast("success", `Address copied: ${state.address}`);
          } catch {
            window.UI.toast("info", `Connected address: ${state.address}`);
          }
          return;
        }
        await connect();
      });
    });

    document.querySelectorAll('[data-role="logout"]').forEach((btn) => {
      btn.addEventListener("click", logout);
    });

    document.querySelectorAll('[data-role="switch-network"]').forEach((btn) => {
      btn.addEventListener("click", () => ensureChain());
    });

    if (hasInjectedWallet() && typeof window.ethereum.on === "function") {
      window.ethereum.on("accountsChanged", () => {
        if (appSessionActive) refresh();
      });
      window.ethereum.on("chainChanged", () => refresh());
    }

    window.UI.bindPendingLinks(document);
    window.UI.bindVerifyHandoff(document);
    refresh()
      .catch((err) => console.error("initial wallet refresh failed", err))
      .finally(() => readyResolve());
  }

  window.Wallet = {
    get state() {
      return state;
    },
    config,
    ready,
    init,
    refresh,
    onChange,
    connect,
    logout,
    ensureChain,
    requireWrite,
    read,
    readPublic,
    write,
    allContracts,
    hasInjectedWallet,
    configMissing,
    expectedChainId,
    isSupportedChain,
    roleLabel: () => ROLE_LABELS[state.role] || "Guest",
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
