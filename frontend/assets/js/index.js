// index.html — landing status cards (DESIGN.md §3.1).
(function () {
  "use strict";

  function render() {
    const expected = document.getElementById("expected-chain");
    const walletEl = document.getElementById("home-wallet");
    const configEl = document.getElementById("home-config");

    if (expected) expected.textContent = Wallet.expectedChainId() ?? "—";

    if (walletEl) {
      const s = Wallet.state;
      if (s.address) {
        const ok = Wallet.isSupportedChain();
        walletEl.innerHTML =
          `<span class="mono">${UI.escapeHtml(s.address)}</span> ` +
          (ok
            ? '<span class="badge badge-ok">writes enabled</span>'
            : '<span class="badge badge-invalid">wrong chain</span>');
      } else {
        walletEl.textContent = Wallet.hasInjectedWallet()
          ? "Not connected — use Connect wallet"
          : "No injected wallet detected (install MetaMask)";
      }
    }

    if (configEl) {
      configEl.innerHTML = Wallet.configMissing()
        ? '<span class="badge badge-invalid">missing — run npm run deploy</span>'
        : `<span class="badge badge-ok">loaded for chain ${Wallet.config.chainId}</span>`;
    }
  }

  Wallet.onChange(render);
  render();
})();
