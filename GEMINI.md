# Meridian — Fibonacci Hybrid Mode (Instructions)

This project has been refactored from an autonomous LLM agent into a **Deterministic Fibonacci Hybrid Bot**. All LLM features have been disabled for performance and cost efficiency.

## Core Architecture
- **Main Entry**: `index.js` (REPL Interface + Background Management Loop).
- **Strategy**: Automated Fibonacci based on Token Inception.
- **Remote Control**: Bidirectional Telegram Integration.
- **State Management**: `state.js` tracks active positions in `state.json`.

## Fibonacci Workflow
1. **ATL/ATH Detection**: Bot performs an "Inception Scan" using Jupiter & Meteora history to find the absolute lowest price since the token was created (True ATL).
2. **Levels**:
   - **Entry**: Price < 0.236 Retracement from ATH.
   - **Range Bottom**: Fibonacci 0.786 level.
3. **Bin Calculation**: Dynamic bin count based on the price distance to 0.786, using the pool's official `bin_step`.

## Operating Instructions
- **Start**: `npm start` in WSL.
- **Commands (Terminal & Telegram)**:
  - `buy <CA> [amount]` : Initiates Fibonacci deployment.
  - `status` : Shows live PnL and range status.
  - `close <index>` : Manual Take Profit / Exit.
  - `manage` : Forced background check.

## Configuration
- `user-config.json` handles `takeProfitPct`, `stopLossPct`, and `deployAmountSol`.
- `.env` handles `DRY_RUN` and `TELEGRAM_BOT_TOKEN`.

---
*Note: This file serves as the foundational mandate for all future modifications.*
