// full-script-resumable.js
//
// This script connects to the Pulsechain RPC endpoint, paginates over a large block range,
// and queries a factory contract for LP pair addresses. For each LP pair, it first checks if the
// liquidity pool's total value (totalSupply * dummy USD value per token) is over $20,000.
// If so, it queries for LP token holders (mint events where tokens are issued from ZeroAddress)
// and then checks each holder’s balance (using retries for timeouts) to see if their individual
// holding is at least $5,000. The qualifying records are appended to a CSV file, and each LP pair
// processed is saved to a checkpoint file. On restarting the script, LP pairs already processed
// (as read from the checkpoint file) are skipped.
//
// To run:
//   1. Install ethers (npm install ethers)
//   2. Run: node lp-scrapper-resumable.js

const { ethers, JsonRpcProvider, ZeroAddress, formatUnits } = require("ethers");
const fs = require("fs");
const path = require("path");

// Configurable file names
const CSV_FILENAME = "lp_qualifiers.csv";
const CHECKPOINT_FILENAME = "checkpoint.json";

// Connect to the Pulsechain RPC endpoint
const provider = new JsonRpcProvider("https://rpc.pulsechain.com");

// Factory contract details
const factoryAddress = "0x5b9f077a77db37f3be0a5b5d31baeff4bc5c0bd7";
const factoryAbi = [
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint)"
];
const factoryContract = new ethers.Contract(factoryAddress, factoryAbi, provider);

// Minimal ERC-20 ABI for LP token contracts
const lpTokenAbi = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)"
];

/**
 * sleep: returns a Promise that resolves after delay milliseconds.
 */
function sleep(delay) {
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * fetchBalanceWithRetries: attempts to fetch the balance for an address with a retry mechanism.
 */
async function fetchBalanceWithRetries(lpContract, address, retries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const balanceBN = await lpContract.balanceOf(address);
      return balanceBN;
    } catch (error) {
      if (error.code === 'ETIMEDOUT' || error.code === 'TIMEOUT') {
        console.error(`Attempt ${attempt} for ${address} failed with timeout.`);
        if (attempt < retries) {
          await sleep(delayMs);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }
}

/**
 * queryFilterPaginated: paginates over a block range and queries for events.
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
    }
  }
  return events;
}

/**
 * getLPPairAddresses: retrieves all LP pair addresses from the factory contract.
 */
async function getLPPairAddresses(fromBlock, toBlock, batchSize) {
  console.log(`Querying PairCreated events from block ${fromBlock} to ${toBlock} in batches of ${batchSize}...`);
  const filter = factoryContract.filters.PairCreated();
  const logs = await queryFilterPaginated(factoryContract, filter, fromBlock, toBlock, batchSize);
  const pairAddresses = logs.map(log => log.args.pair);
  return [...new Set(pairAddresses)];
}

/**
 * getLPHolders: for a given LP token contract address, retrieves all addresses that received tokens via mint events.
 */
async function getLPHolders(lpAddress, fromBlock, toBlock, batchSize) {
  const lpContract = new ethers.Contract(lpAddress, lpTokenAbi, provider);
  const filter = lpContract.filters.Transfer(ZeroAddress, null);
  const logs = await queryFilterPaginated(lpContract, filter, fromBlock, toBlock, batchSize);
  const holderAddresses = logs.map(log => log.args.to);
  return [...new Set(holderAddresses)];
}

/**
 * getLPTokenUSDValue: dummy function returning a fixed USD value per LP token.
 */
async function getLPTokenUSDValue(lpAddress) {
  return 5; // Assume each LP token is worth $5
}

/**
 * getLiquidityPoolValue: computes the total USD value of the LP token pool.
 */
async function getLiquidityPoolValue(lpAddress, decimals = 18) {
  const lpContract = new ethers.Contract(lpAddress, lpTokenAbi, provider);
  try {
    const totalSupplyBN = await lpContract.totalSupply();
    const totalSupply = parseFloat(formatUnits(totalSupplyBN, decimals));
    const lpTokenUSDValue = await getLPTokenUSDValue(lpAddress);
    const poolValue = totalSupply * lpTokenUSDValue;
    return poolValue;
  } catch (err) {
    console.error(`Error fetching totalSupply for LP ${lpAddress}:`, err);
    return 0;
  }
}

/**
 * checkLPHolderValue: for each LP holder address, queries the balance (with retries)
 * and filters those with a holding value >= $5000.
 */
async function checkLPHolderValue(lpAddress, holderAddresses, lpTokenUSDValue, decimals = 18) {
  const lpContract = new ethers.Contract(lpAddress, lpTokenAbi, provider);
  let qualifyingHolders = [];
  for (const addr of holderAddresses) {
    try {
      const balanceBN = await fetchBalanceWithRetries(lpContract, addr, 3, 2000);
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
 * appendRecordsToCSV: appends qualifying records to the CSV file.
 */
function appendRecordsToCSV(records, filename) {
  // If file doesn't exist, write header first.
  if (!fs.existsSync(filename)) {
    fs.writeFileSync(filename, "lpAddress,holderAddress,balance,holdingValue\n");
  }
  const rows = records.map(record => 
    `${record.lpAddress},${record.holderAddress},${record.balance},${record.holdingValue}`
  ).join("\n") + "\n";
  fs.appendFileSync(filename, rows);
  console.log(`Appended ${records.length} records to ${filename}`);
}

/**
 * loadCheckpoint: reads the checkpoint file if it exists.
 */
function loadCheckpoint(filename) {
  if (fs.existsSync(filename)) {
    try {
      const data = fs.readFileSync(filename, "utf8");
      return JSON.parse(data);
    } catch (e) {
      console.error("Error parsing checkpoint file. Starting fresh.");
      return [];
    }
  } else {
    return [];
  }
}

/**
 * saveCheckpoint: writes the checkpoint array to disk.
 */
function saveCheckpoint(filename, checkpoint) {
  fs.writeFileSync(filename, JSON.stringify(checkpoint, null, 2));
}

/**
 * main: Orchestrates the paginated queries and writes output.
 * It uses a checkpoint file to remember which LP pairs have been processed.
 */
async function main() {
  const fromBlock = 18672539;
  const latestBlock = await provider.getBlockNumber();
  const toBlock = latestBlock;
  const batchSize = 5000; // Adjust based on provider limits

  console.log(`Scraping events from block ${fromBlock} to ${toBlock} in batches of ${batchSize}...`);

  // Load the checkpoint (an array of already processed LP pair addresses)
  let checkpoint = loadCheckpoint(CHECKPOINT_FILENAME);
  console.log("Checkpoint loaded:", checkpoint);

  // Step 1: Get all LP pair addresses using pagination.
  const lpPairAddresses = await getLPPairAddresses(fromBlock, toBlock, batchSize);
  console.log("Found LP pair addresses:", lpPairAddresses);

  // Filter out LP pairs that have already been processed.
  const lpPairsToProcess = lpPairAddresses.filter(addr => !checkpoint.includes(addr));
  console.log(`Processing ${lpPairsToProcess.length} new LP pair addresses...`);

  // Process each new LP pair
  for (const lpAddress of lpPairsToProcess) {
    console.log(`\nProcessing LP pair contract: ${lpAddress}`);
    try {
      // Step 2: Check if the liquidity pool's total value is > $20,000.
      const poolValue = await getLiquidityPoolValue(lpAddress);
      console.log(`Liquidity pool value for ${lpAddress}: $${poolValue.toFixed(2)}`);
      if (poolValue >= 20000) {
        console.log(`Skipping LP pair ${lpAddress} because total liquidity is not over $20,000.`);
        // Add to checkpoint so we don't try again
        checkpoint.push(lpAddress);
        saveCheckpoint(CHECKPOINT_FILENAME, checkpoint);
        continue;
      }
      
      // Step 3: Query for LP token holders using pagination.
      const holders = await getLPHolders(lpAddress, fromBlock, toBlock, batchSize);
      console.log(`Found ${holders.length} LP token holders in ${lpAddress}`);
      
      // Step 4: For each holder, check if individual holding value is >= $5000.
      const lpTokenUSDValue = await getLPTokenUSDValue(lpAddress);
      const qualifyingHolders = await checkLPHolderValue(lpAddress, holders, lpTokenUSDValue);
      console.log(`Qualifying LP token holders in ${lpAddress} (>= $5000):`);
      console.table(qualifyingHolders);
      
      // Append qualifying records to CSV
      if (qualifyingHolders.length > 0) {
        appendRecordsToCSV(qualifyingHolders, CSV_FILENAME);
      }
      
      // Mark this LP pair as processed by adding it to the checkpoint.
      checkpoint.push(lpAddress);
      saveCheckpoint(CHECKPOINT_FILENAME, checkpoint);
    } catch (err) {
      console.error(`Error processing LP pair ${lpAddress}:`, err);
      // Optionally, you could decide whether to add this LP pair to the checkpoint even if it fails,
      // or to leave it for a retry on the next run.
    }
  }
  console.log("Scraping complete.");
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error("Error during scraping:", error);
    process.exit(1);
  });
