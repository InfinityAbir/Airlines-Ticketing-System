// Minimal EIP-1193 wallet shim over the local Hardhat node (127.0.0.1:8545).
// Injected with Playwright's addInitScript before any page script runs, so the vanilla
// frontend sees a wallet provider without MetaMask.
// Mode "connected": eth_accounts returns the configured account (already authorized).
// Mode "guest":     eth_accounts returns [] until eth_requestAccounts is called.
// All other JSON-RPC methods are forwarded to the node unchanged.
(() => {
  const RPC = "http://127.0.0.1:8545";
  let account = window.__WALLET_ACCOUNT || null;
  let mode = window.__WALLET_MODE || "connected";
  let id = 0;
  const listeners = {};

  async function rpc(method, params) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: (id += 1), method, params: params || [] }),
    });
    const body = await res.json();
    if (body.error) {
      const err = new Error(body.error.message || "rpc error");
      err.code = body.error.code;
      err.data = body.error.data;
      throw err;
    }
    return body.result;
  }

  const ethereum = {
    isMetaMask: true,
    chainId: "0x7a69",
    get selectedAddress() {
      return mode === "connected" ? account : null;
    },
    request: async ({ method, params }) => {
      switch (method) {
        case "eth_accounts":
          return mode === "connected" && account ? [account] : [];
        case "eth_requestAccounts":
          if (!account) throw new Error("no test account configured");
          mode = "connected";
          return [account];
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null;
        case "net_version":
          return "31337";
        default:
          return rpc(method, params);
      }
    },
    on: (event, fn) => {
      (listeners[event] = listeners[event] || []).push(fn);
    },
    removeListener: (event, fn) => {
      listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
    },
    removeEventListener: (event, fn) => ethereum.removeListener(event, fn),
    enable: async () => ethereum.request({ method: "eth_requestAccounts" }),
  };

  Object.defineProperty(window, "ethereum", { value: ethereum, configurable: false });

  // Test hook: switch the active account / mode without reloading.
  window.__setWallet = (nextAccount, nextMode) => {
    const prev = account;
    if (nextAccount) account = nextAccount;
    if (nextMode) mode = nextMode;
    const current = mode === "connected" ? [account] : [];
    (listeners.accountsChanged || []).forEach((fn) => fn(current));
    return prev;
  };
  window.__getWallet = () => ({ account, mode });
})();
