// full-script-with-pagination.js
//
// This script connects to the Pulsechain RPC endpoint,
// queries the factory contract for all LP pair addresses over a large block range
// (using pagination), then for each LP pair contract queries for mint events (Transfer events from ZeroAddress)
// to retrieve LP token holder addresses. For each holder, it checks their balance and filters those with holdings
// >= $5000 (using a dummy valuation function). Finally, it saves the qualifying records to a CSV file.
//
// To run:
//   1. Install ethers and Node.js fs module is built in: npm install ethers
//   2. Run with: node full-script-with-pagination.js

const { ethers, JsonRpcProvider, ZeroAddress, formatUnits } = require("ethers");
const fs = require("fs");

// Connect to your RPC provider (Pulsechain endpoint in this example)
const provider = new JsonRpcProvider("https://rpc.pulsechain.com");

// Factory contract details (replace with your actual factory contract address if needed)
const factoryAddress = "0x5b9f077a77db37f3be0a5b5d31baeff4bc5c0bd7";
const factoryAbi = [
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint)"
];
const factoryContract = new ethers.Contract(factoryAddress, factoryAbi, provider);

// Minimal ERC-20 ABI for LP token contracts (to capture mint events and query balances)
const lpTokenAbi = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)"
];

/**
 * queryFilterPaginated
 *
 * Generic helper to paginate queries over a block range.
 *
 * @param {Contract} contract - The ethers Contract instance.
 * @param {EventFilter} filter - The event filter to use.
 * @param {number} fromBlock - Starting block number.
 * @param {number} toBlock - Ending block number.
 * @param {number} batchSize - The number of blocks per batch.
 * @returns {Promise<Array>} - Aggregated events.
 */
async function queryFilterPaginated(contract, filter, fromBlock, toBlock, batchSize) {
  let events = [];
  for (let current = fromBlock; current <= toBlock; current += batchSize) {
    const start = current;
    const end = Math.min(current + batchSize - 1, toBlock);
    console.log(`Querying events from blocks ${start} to ${end}...`);
    try {
      const batch = await contract.queryFilter(filter, start, end);
      console.log(`  Found ${batch.length} events in batch ${start}-${end}`);
      events.push(...batch);
    } catch (error) {
      console.error(`  Error querying blocks ${start} to ${end}:`, error);
      // Optionally implement retries or adjust batchSize here
    }
  }
  return events;
}

/**
 * getLPPairAddresses
 *
 * Retrieves all LP pair addresses from the factory contract by paginating the PairCreated events.
 *
 * @param {number} fromBlock - Starting block.
 * @param {number} toBlock - Ending block.
 * @param {number} batchSize - Batch size.
 * @returns {Promise<Array>} - Array of unique LP pair addresses.
 */
async function getLPPairAddresses(fromBlock, toBlock, batchSize) {
  console.log(`Querying PairCreated events from block ${fromBlock} to ${toBlock} in batches of ${batchSize}...`);
  const filter = factoryContract.filters.PairCreated();
  const logs = await queryFilterPaginated(factoryContract, filter, fromBlock, toBlock, batchSize);
  const pairAddresses = logs.map(log => log.args.pair);
  return [...new Set(pairAddresses)];
}

/**
 * getLPHolders
 *
 * For a given LP token contract address, retrieves all addresses that received tokens via minting
 * (i.e. Transfer events from ZeroAddress) using pagination.
 *
 * @param {string} lpAddress - The LP token contract address.
 * @param {number} fromBlock - Starting block.
 * @param {number} toBlock - Ending block.
 * @param {number} batchSize - Batch size.
 * @returns {Promise<Array>} - Array of unique holder addresses.
 */
async function getLPHolders(lpAddress, fromBlock, toBlock, batchSize) {
  const lpContract = new ethers.Contract(lpAddress, lpTokenAbi, provider);
  const filter = lpContract.filters.Transfer(ZeroAddress, null);
  const logs = await queryFilterPaginated(lpContract, filter, fromBlock, toBlock, batchSize);
  const holderAddresses = logs.map(log => log.args.to);
  return [...new Set(holderAddresses)];
}

/**
 * getLPTokenUSDValue
 *
 * Dummy function that returns a fixed USD value per LP token.
 * Replace with actual logic (e.g. calculating TVL / totalSupply) as needed.
 *
 * @param {string} lpAddress - The LP token contract address.
 * @returns {Promise<number>} - USD value per LP token.
 */
async function getLPTokenUSDValue(lpAddress) {
  return 5; // Assume each LP token is worth $5
}

/**
 * checkLPHolderValue
 *
 * For each LP holder address, queries the LP token balance and filters out those whose USD holding is below $5000.
 *
 * @param {string} lpAddress - The LP token contract address.
 * @param {Array} holderAddresses - Array of holder addresses.
 * @param {number} lpTokenUSDValue - USD value per LP token.
 * @param {number} decimals - Token decimals (default: 18).
 * @returns {Promise<Array>} - Array of qualifying holder records.
 */
async function checkLPHolderValue(lpAddress, holderAddresses, lpTokenUSDValue, decimals = 18) {
  const lpContract = new ethers.Contract(lpAddress, lpTokenAbi, provider);
  let qualifyingHolders = [];
  for (const addr of holderAddresses) {
    try {
      const balanceBN = await lpContract.balanceOf(addr);
      const balance = parseFloat(formatUnits(balanceBN, decimals));
      const holdingValue = balance * lpTokenUSDValue;
      if (holdingValue >= 5000) {
        qualifyingHolders.push({
          lpAddress,
          holderAddress: addr,
          balance,
          holdingValue
        });
      }
    } catch (err) {
      console.error(`Error fetching balance for ${addr} in LP ${lpAddress}:`, err);
    }
  }
  return qualifyingHolders;
}

/**
 * saveEventsToCSV
 *
 * Saves an array of qualifying LP holder records to a CSV file.
 *
 * @param {Array} records - Array of holder records.
 * @param {string} filename - Output CSV filename.
 */
function saveEventsToCSV(records, filename) {
  let csvRows = ["lpAddress,holderAddress,balance,holdingValue"];
  records.forEach(record => {
    csvRows.push(`${record.lpAddress},${record.holderAddress},${record.balance},${record.holdingValue}`);
  });
  const csvContent = csvRows.join("\n");
  fs.writeFileSync(filename, csvContent);
  console.log(`CSV file saved as ${filename}`);
}

/**
 * main
 *
 * Orchestrates the paginated queries and writes the output to a CSV file.
 */
async function main() {
  // Define the block range.
  const fromBlock = 18672539;
  // Resolve "latest" to an actual block number.
  const latestBlock = 20385123;
  const toBlock = latestBlock;
  const batchSize = 5000; // Adjust based on provider limits

  console.log(`Scraping events from block ${fromBlock} to ${toBlock} in batches of ${batchSize}...`);

  // Step 1: Get all LP pair addresses from the factory contract using pagination.
  const lpPairAddresses = await getLPPairAddresses(fromBlock, toBlock, batchSize);
  console.log("Found LP pair addresses:", lpPairAddresses);

  let allQualifyingHolders = [];

  // Step 2: For each LP pair contract, query for LP token holders and filter by USD threshold.
  for (const lpAddress of lpPairAddresses) {
    console.log(`\nProcessing LP pair contract: ${lpAddress}`);
    try {
      const holders = await getLPHolders(lpAddress, fromBlock, toBlock, batchSize);
      console.log(`Found ${holders.length} LP token holders in ${lpAddress}`);
      
      const lpTokenUSDValue = await getLPTokenUSDValue(lpAddress);
      const qualifyingHolders = await checkLPHolderValue(lpAddress, holders, lpTokenUSDValue);
      
      console.log(`Qualifying LP token holders in ${lpAddress} (holding >= $5000):`);
      console.table(qualifyingHolders);
      
      allQualifyingHolders.push(...qualifyingHolders);
    } catch (err) {
      console.error(`Error processing LP pair ${lpAddress}:`, err);
    }
  }

  // Save all qualifying LP holder records to a CSV file.
  saveEventsToCSV(allQualifyingHolders, "lp_qualifiers.csv");
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error("Error during scraping:", error);
    process.exit(1);
  });
