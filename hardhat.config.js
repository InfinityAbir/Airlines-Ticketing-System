import hardhatEthers from "@nomicfoundation/hardhat-ethers";

// SOLC_OPTIMIZER=1 compiles with the optimizer enabled (runs=200) for the gas
// comparison in the paper's evaluation section. The default (unset) keeps the
// unoptimized build that every test, gate, and reported figure is pinned to.
const optimizerEnabled = process.env.SOLC_OPTIMIZER === "1";

/** @type import('hardhat/config').HardhatUserConfig */
export default {
  plugins: [hardhatEthers],
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: optimizerEnabled, runs: 200 },
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainId: 31337,
    },
    localhost: {
      type: "http",
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
  },
};
