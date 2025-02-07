
# LP Qualifiers Scraper

This repository contains a Node.js script that scrapes liquidity pool (LP) data from Pulsechain. The script queries a factory contract for LP pair addresses, checks each LP pair’s total liquidity, and—if the pool’s total liquidity is over \$20,000—scrapes LP token holders with individual holdings worth at least \$5,000. The qualifying data is then appended to a CSV file. In addition, the script supports resumability by saving progress (checkpointing) so that if the process is interrupted, it can resume from where it left off.

## Features

- **Large Block Range Pagination:**  
  Splits the query of events over a large block range into smaller batches to prevent timeouts.

- **Liquidity Pool Filtering:**  
  Processes only those LP pairs whose total liquidity value (calculated as totalSupply × dummy USD value) is greater than \$20,000.

- **Holder Filtering:**  
  For each LP pair that passes the liquidity check, the script retrieves LP token holders (from mint events) and filters out those with individual holdings under \$5,000.

- **Retry Mechanism:**  
  Implements retries for balance queries that time out.

- **Resumable Scraping:**  
  Saves processed LP pair addresses in a checkpoint file so that the scraper can resume from the last processed LP pair if interrupted.

- **CSV Output:**  
  Appends qualifying records (LP pair address, holder address, balance, and holding value) to a CSV file.

## Prerequisites

- [Node.js](https://nodejs.org/) (v14 or later is recommended)
- [npm](https://www.npmjs.com/)

## Installation

1. **Clone the Repository:**

   ```bash
   git clone https://github.com/yourusername/lp-qualifiers-scraper.git
   cd lp-qualifiers-scraper
   ```

2. **Install Dependencies:**

   The script uses [ethers.js](https://docs.ethers.org/) to interact with Pulsechain. Install it via npm:

   ```bash
   npm install ethers
   ```

## Script Overview

The script (`full-script-resumable.js`) performs the following steps:

1. **Connection & Contract Setup:**  
   Connects to the Pulsechain RPC endpoint and instantiates the factory contract using a minimal ABI that listens for the `PairCreated` event. It also defines an ERC-20 minimal ABI for LP token contracts (to capture mint events and query balances).

2. **Pagination:**  
   Uses the function `queryFilterPaginated` to break down large block ranges into smaller batches (e.g., 5000 blocks per batch) so that event queries do not time out.

3. **LP Pair Extraction:**  
   The function `getLPPairAddresses` retrieves all unique LP pair addresses from the factory contract’s `PairCreated` events over the specified block range.

4. **Liquidity Check:**  
   For each LP pair, the script calls `getLiquidityPoolValue` (which uses the LP token’s `totalSupply` and a dummy USD value per token) to compute the total liquidity. Only LP pairs with a total liquidity greater than \$20,000 are processed further.

5. **LP Holder Extraction:**  
   For qualifying LP pairs, the function `getLPHolders` queries the LP token’s mint events (Transfer events from the ZeroAddress) to extract unique holder addresses.

6. **Balance Query with Retry:**  
   The function `fetchBalanceWithRetries` attempts to query each holder’s LP token balance with retries if timeouts occur.

7. **Holder Filtering:**  
   The function `checkLPHolderValue` computes the USD value for each holder’s balance and filters out addresses holding less than \$5,000.

8. **Output & Checkpointing:**  
   - Qualifying LP holder records are appended to a CSV file (`lp_qualifiers.csv`).  
   - After processing an LP pair, its address is saved in a checkpoint file (`checkpoint.json`). If you rerun the script, it resumes by skipping LP pairs that were already processed.

## Usage

To run the script, use Node.js:

```bash
node full-script-resumable.js
```

The script will:
- Connect to the RPC endpoint.
- Query for LP pair addresses from block 18672539 to the latest block.
- For each LP pair (with liquidity > \$20,000), it will scrape LP token holders and filter based on a minimum individual holding value of \$5,000.
- Append qualifying records to `lp_qualifiers.csv`.
- Save processed LP pairs to `checkpoint.json` to enable resumability.

## Configuration

You can adjust the following in the script:
- **RPC Endpoint:**  
  Change the URL in the `JsonRpcProvider` constructor.
- **Block Range & Batch Size:**  
  Modify `fromBlock`, `toBlock`, and `batchSize` in the `main` function.
- **Dummy Valuation:**  
  The function `getLPTokenUSDValue` currently returns \$5. Replace it with your real valuation logic as needed.
- **Minimum Thresholds:**  
  The script currently filters for LP pairs with liquidity > \$20,000 and for LP holders with individual holdings >= \$5,000. Adjust these values as needed.

## Troubleshooting

- **Timeout Errors:**  
  The script includes a retry mechanism for balance queries. You can increase the number of retries or delay between attempts by modifying the parameters in `fetchBalanceWithRetries`.
- **Resumability:**  
  If the script stops unexpectedly, re-run it. The checkpoint file (`checkpoint.json`) ensures that already-processed LP pairs are skipped.
- **Dependencies:**  
  Ensure that ethers.js is installed. Use `npm install ethers` if needed.

## Contributing

Contributions are welcome! Please fork this repository and create a pull request with your improvements. If you find any bugs or have suggestions for new features (like improved error handling or enhanced valuation logic), please open an issue.

## License

This project is licensed under the MIT License.

---
