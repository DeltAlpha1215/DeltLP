# DeltLP — Fibonacci Hybrid Bot

**Deterministic Fibonacci-based Liquidity Management Bot for Meteora DLMM on Solana.**

DeltLP has evolved from an autonomous LLM agent into a **high-performance, cost-efficient Hybrid Bot**. It uses absolute price history (ATL/ATH) and Fibonacci retracement levels to automate entries and range management in Meteora DLMM pools, controllable via Terminal and Telegram.

---

## Core Strategy: Fibonacci Inception

The bot operates on a strictly mathematical model to capture value during token accumulation phases:

1.  **Inception Scan**: Using Jupiter and Meteora historical data, the bot identifies the "True ATL" (absolute lowest price) since token creation.
2.  **Entry Level**: Positions are only opened when the price drops below the **0.236 Fibonacci Retracement** level from the current ATH.
3.  **Range Target**: The liquidity range is dynamically deployed down to the **0.786 Fibonacci** level.
4.  **Bin Optimization**: Automatically calculates the optimal number of bins based on the target range and the pool's official `bin_step`.

---

## Key Features

- **Fibonacci Entry/Exit**: Precision math-based deployments instead of speculative AI.
- **Telegram Remote Control**: Full bidirectional control via Telegram Bot (commands: `/lp`, `/status`, `/close`, `/tp`, `/config`).
- **AS/AR Modes**:
    - **Auto-Swap (AS)**: Automatically converts all proceeds back to SOL upon closing a position.
    - **Auto-Reentry (AR)**: Resets and waits for a new 0.236 entry if the token hits a new ATH.
- **Advanced Take Profit**:
    - **Trailing TP**: Locks profit floors and trails upward to maximize gains.
    - **Bollinger TP**: Uses 15m BB Upper hits for mean-reversion exits.
- **Profit Fee System**: A 1% fee is automatically deducted from **realized profits** only (No profit = No fee).
- **Token Health Audit**: Real-time screening for "slow rugs" and liquidity health.

---

## Requirements

- Node.js 18+
- Solana wallet (base58 private key)
- Solana RPC endpoint (WSL environment recommended)
- Telegram Bot Token (for remote control)
- Helius API Key (for balance and metadata lookups)

---

## Setup

### 1. Installation

```bash
git clone https://github.com/yunus-0x/deltlp
cd deltlp
npm install
```

### 2. Configuration

Create a `.env` file in the root directory:

```env
WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=your_solana_rpc_url
HELIUS_API_KEY=your_helius_api_key
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_personal_chat_id
DRY_RUN=false
```

Edit `user-config.json` for risk management:
- `deployAmountSol`: Default amount per position.
- `globalMaxCapSol`: Total SOL allowed to be "in play" at once.
- `feeWallet`: Wallet address to receive the 1% profit fee.

### 3. Running the Bot

**Using PM2 (Recommended for 24/7 operation):**
```bash
npm run pm2:start
```

**Manual Start:**
```bash
npm start
```

---

## Command Reference

### Telegram Commands
| Command | Description |
|---|---|
| `/status` | View active positions, PnL, and wallet balance. |
| `/lp <CA> [Amt] [AS] [AR]` | Initiate Fibonacci deployment for a token. |
| `/close <index>` | Manually close a position. |
| `/tp <tr/bb/off> <index>` | Set TP mode (Trailing, Bollinger, or Static). |
| `/ar <on/off> <index>` | Toggle Auto-Reentry for a position. |
| `/config` | View current global settings and fee status. |
| `/top` | Scan for top-performing Meteora pools. |

### Terminal (REPL) Commands
- `lp <CA> <Amount> [AS] [AR]`
- `status`
- `close <index>`
- `manage` (Manual trigger for position check)

---

## Disclaimer

This software is a financial tool. Running a trading bot carries significant risk. You may lose your capital. Always test with small amounts first. The authors are not responsible for any financial losses incurred.

**Not Financial Advice.**
