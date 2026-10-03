// Frontend app settings (no secrets — endpoint URLs only; PRD §5.2).
window.APP_CONFIG = {
  // Local JSON-RPC endpoint used for wallet-less public reads (verify.html, QR deep links).
  rpcUrl: "http://127.0.0.1:8545",
  // Protected upload endpoint (server/upload.js, started with `npm run upload`).
  uploadEndpoint: "http://127.0.0.1:8787/api/upload",
  uploadTimeoutMs: 10000,
  // Public gateway used to retrieve IPFS-sourced ticket metadata for FR-18 checks.
  ipfsGateway: "https://ipfs.io/ipfs/",
  metadataFetchTimeoutMs: 8000,
};
