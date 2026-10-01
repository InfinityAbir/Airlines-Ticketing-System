import hardhatEthers from "@nomicfoundation/hardhat-ethers";

/** @type import('hardhat/config').HardhatUserConfig */
export default {
  plugins: [hardhatEthers],
  solidity: "0.8.28",
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
