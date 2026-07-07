import "dotenv/config";
import readline from "readline";

// Suppress non-fatal bigint warning
const originalWarn = console.warn;
const originalErr = console.error;

const isBigIntWarning = (arg) => 
    typeof arg === 'string' && 
    (arg.includes('bigint: Failed to load bindings') || arg.includes('pure JS will be used'));

console.warn = (...args) => {
  if (isBigIntWarning(args[0])) return;
  originalWarn(...args);
};
console.error = (...args) => {
  if (isBigIntWarning(args[0])) return;
  originalErr(...args);
};

import { log } from "./logger.js";
import { config } from "./config.js";
import * as dlmm from "./tools/dlmm.js";
import * as indicators from "./tools/chart-indicators.js";
import * as wallet from "./tools/wallet.js";
import * as telegram from "./telegram.js";
import * as state from "./state.js";
import * as gmgn from "./tools/gmgn.js";
import * as lo from "./tools/limit-order.js";
import * as health from "./tools/health.js";
import * as meteoraTop from "./tools/meteora-top.js";
import * as tui from "./tui.js";
import * as memory from "./tools/supermemory.js";

const pendingOrders = new Map();

/**
 * Batalkan pemantauan CA yang sedang berjalan
 */
function cancelOrder(ca) {
    if (pendingOrders.has(ca)) {
        const order = pendingOrders.get(ca);
        clearInterval(order.interval);
        pendingOrders.delete(ca);
        return true;
    }
    return false;
}

/**
 * Mendapatkan ATH/ATL Global (Sejak Lahir) secara stabil via GMGN (Native SOL)
 */
async function getAbsoluteAnchors(ca, poolAddr) {
    console.log("🔍 Mencari Inception Price (Harga Lahir) via GMGN.ai...");
    let athSol = 0;
    let atlSol = 0; 
    let supply = 0;
    let athMcapUsd = 0;

    // 1. Ambil Data dari GMGN (Source of Truth)
    try {
        const tokenInfo = await gmgn.fetchTokenInfo_GMGN(ca);
        if (tokenInfo) {
            supply = tokenInfo.supply;
            athMcapUsd = tokenInfo.ath_mcap_usd;
            athSol = tokenInfo.ath_sol;
            console.log(`✅ Metadata GMGN: ATH ${athSol.toFixed(10)} SOL (MCap: $${Math.round(athMcapUsd).toLocaleString()})`);
            
            const tokenHistory = await gmgn.fetchTokenHistory_GMGN(ca, tokenInfo.sol_per_usd_ratio, "1h");
            if (tokenHistory) {
                const historyAth = tokenHistory.ath;
                if (historyAth > 0 && historyAth < (athSol * 10)) {
                    if (historyAth > athSol) {
                        athSol = historyAth;
                        const solPrice = await getSolPriceUsd();
                        const newMcapUsd = athSol * supply * solPrice;
                        if (newMcapUsd > athMcapUsd) {
                            athMcapUsd = newMcapUsd;
                            console.log(`📈 Peak History baru ditemukan! Update ATH MCap ke: $${Math.round(athMcapUsd).toLocaleString()}`);
                        }
                    }
                }
                atlSol = tokenHistory.atl;
                console.log(`✅ History GMGN: ATH ${athSol.toFixed(10)} SOL | ATL ${atlSol.toFixed(10)} SOL`);
            }
        }
    } catch (e) {
        log("error", `GMGN Data Fetch Failed: ${e.message}`);
    }

    try {
        const solPrice = await getSolPriceUsd();
        const priceJson = await fetchWithLog(`https://api.jup.ag/price/v3?ids=${ca}`, "Jupiter Price V3");
        const usdPrice = priceJson[ca]?.usdPrice;
        if (usdPrice) {
            const currentPriceSol = usdPrice / solPrice;
            if (currentPriceSol > athSol) {
                athSol = currentPriceSol;
                console.log(`📈 Harga saat ini (${athSol.toFixed(10)} SOL) lebih tinggi dari ATH. Menggunakan harga saat ini.`);
            }
        }
    } catch (e) { }

    if (!atlSol || atlSol < 0.000000001) atlSol = 0.000000044; 
    if (!athSol || athSol < atlSol) athSol = atlSol * 1.5;

    return { ath: athSol, atl: atlSol, supply, athMcapUsd };
}

async function getSolPriceUsd() {
    try {
        const res = await fetch("https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112");
        const json = await res.json();
        const price = parseFloat(json["So11111111111111111111111111111111111111112"]?.usdPrice);
        if (!isNaN(price) && price > 0) return price;
    } catch { }
    return 150; // Manual fallback
}

async function fetchWithLog(url, name) {
    try {
        const res = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        log("error", `Fetch failed for ${name}: ${e.message}`);
        throw e;
    }
}

async function smartClosePosition(positionAddress, pair, pnlPct, pnlUsd, reason) {
    try {
        const tracked = state.getTrackedPosition(positionAddress);
        const useAutoSwap = tracked?.autoSwap || false;
        let baseMint = tracked?.baseMint;
        
        if (baseMint && typeof baseMint === 'object') {
            baseMint = baseMint.mint || baseMint.address;
        }

        console.log(`🚀 [DEBUG] Memulai Smart Close untuk ${pair}...`);
        let res = await dlmm.closePosition({ 
            position_address: positionAddress, 
            skip_swap: useAutoSwap, 
            reason 
        });

        if (!res.success) {
            if (res.error?.includes("429") || res.error?.includes("timeout")) {
                await new Promise(r => setTimeout(r, 3000));
                const posData = await dlmm.getMyPositions({ force: true });
                const stillExists = posData.positions?.some(p => p.position === positionAddress);
                if (!stillExists) res = { success: true }; 
            }
        }

        if (!res.success) return false;

        console.log(`✅ [DEBUG] Tahap 1 Sukses: Posisi di Meteora ditutup.`);
        state.untrackPosition(positionAddress);

        if (useAutoSwap && baseMint) {
            console.log(`🔄 [DEBUG] Melakukan Auto-Swap via Jupiter...`);
            await new Promise(r => setTimeout(r, 5000));
            const balances = await wallet.getWalletBalances();
            const tokenEntry = balances.tokens?.find(t => t.mint === baseMint);
            if (tokenEntry && tokenEntry.balance > 0) {
                await wallet.swapToken({
                    input_mint: baseMint,
                    output_mint: "So11111111111111111111111111111111111111112",
                    amount: tokenEntry.balance
                });
            }
        }

        if (pnlUsd > 0 && config.management.feeWallet && config.management.feeEnabled) {
            try {
                let profitInSol = pnlUsd;
                if (!config.management.solMode) {
                    const solPrice = await getSolPriceUsd();
                    profitInSol = pnlUsd / solPrice;
                }
                const feeAmount = profitInSol * (config.management.feePct / 100);
                if (feeAmount > 0.000001) {
                    await wallet.transferSol(config.management.feeWallet, feeAmount);
                }
            } catch (feeErr) { }
        }

        await telegram.notifyClose({ pair, pnlPct, pnlUsd });
        return true;

    } catch (err) {
        return false;
    }
}

export async function runManagementCycle({ silent = false } = {}) {
  try {
    const posData = await dlmm.getMyPositions({ force: true });
    const positions = posData.positions || [];
    if (positions.length === 0) return "No positions.";

    for (const pos of positions) {
      if (pos.age_minutes < 5) continue;
      const pnlData = await dlmm.getPositionPnl({ pool_address: pos.pool, position_address: pos.position });
      if (pnlData.error) continue;
      const pnl = pnlData.pnl_pct || 0;
      const tracked = state.getTrackedPosition(pos.position);
      const sl = tracked?.stopLossPct || config.management.stopLossPct || -15;

      if (pnl <= sl) {
        await smartClosePosition(pos.position, pos.pair, pnl, pnlData.pnl_usd, `Auto-SL ${sl}%`);
      } else if (pnl >= 7) {
        await smartClosePosition(pos.position, pos.pair, pnl, pnlData.pnl_usd, `Auto-TP 7%`);
      }
    }
    return "Check complete.";
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

async function executeFibDeploy(pool, amountSol, currentPrice, bottomPrice, autoSwap = false, baseMint = null, bottomLevel = 0.786, autoReentry = false, entryPrice = null, mode = "fibo") {
    console.log(`🚀 MENGEKSEKUSI LP ${mode.toUpperCase()}...`);
    const balances = await wallet.getWalletBalances();
    const safeBuffer = 0.05; // Buffer for rent and gas
    if (balances.sol < amountSol + safeBuffer) {
        console.log(`❌ Balance SOL tidak cukup untuk rent/gas (Butuh ~${(amountSol + safeBuffer).toFixed(3)} SOL)`);
        return;
    }

    const binStep = Number(pool.bin_step || pool.binStep || 100);
    let targetPrice = bottomPrice;
    const priceRatio = currentPrice / targetPrice;
    const binsNeeded = Math.abs(Math.round(Math.log(priceRatio) / (binStep * Math.log(1.0001))));
    let finalBins = Math.max(10, Math.min(450, binsNeeded));

    try {
        const res = await dlmm.deployPosition({
            pool_address: pool.pool,
            amount_sol: amountSol,
            strategy: "bid_ask",
            bins_below: finalBins,
            bins_above: 0,
            volatility: 100
        });

        if (res.success) {
            let finalBaseMint = null;
            if (typeof baseMint === 'string') {
                finalBaseMint = baseMint;
            } else if (baseMint && typeof baseMint === 'object') {
                finalBaseMint = baseMint.mint || baseMint.address;
            } else {
                const xAddr = typeof pool.token_x === 'object' ? pool.token_x?.address : pool.token_x;
                const yAddr = typeof pool.token_y === 'object' ? pool.token_y?.address : pool.token_y;
                finalBaseMint = xAddr === "So11111111111111111111111111111111111111112" ? yAddr : xAddr;
            }
            state.trackPosition(res.position, { 
                pool: pool.pool, 
                pair: pool.name, 
                autoSwap,
                autoReentry,
                tpMode: "static",
                baseMint: finalBaseMint,
                amountSol: amountSol
            });
            telegram.notifyDeploy({ pair: pool.name, amountSol, position: res.position });
            
            // 🔥 Store to Supermemory
            await memory.addMemory(`User opened ${mode.toUpperCase()} position on ${pool.name} with ${amountSol} SOL. AutoSwap: ${autoSwap}, AutoReentry: ${autoReentry}`, ["deployment", "success", pool.name]);
        } else {
            console.log(`❌ Eksekusi Gagal: ${res.error}`);
            await memory.addMemory(`Failed to deploy ${mode.toUpperCase()} on ${pool.name}: ${res.error}`, ["deployment", "failure"]);
        }
    } catch (e) {
        console.log(`❌ Error Sistem saat Deploy: ${e.message}`);
    }
}

async function executeVolDeploy(pool, amountSol, volMult = 5, autoSwap = false, autoReentry = false) {
    console.log(`🚀 MENGEKSEKUSI LP VOLATILITY (x${volMult})...`);
    const balances = await wallet.getWalletBalances();
    const safeBuffer = 0.05;
    if (balances.sol < amountSol + safeBuffer) {
        console.log(`❌ Balance SOL tidak cukup untuk rent/gas (Butuh ~${(amountSol + safeBuffer).toFixed(3)} SOL)`);
        return;
    }

    const pInf = await meteoraTop.getPoolVolatility(pool.pool);
    const vol = pInf ? pInf.volatility : 2.0;
    const finalBins = Math.max(10, Math.min(450, Math.round(vol * volMult)));

    try {
        const res = await dlmm.deployPosition({
            pool_address: pool.pool,
            amount_sol: amountSol,
            strategy: "bid_ask",
            bins_below: finalBins,
            bins_above: 0,
            volatility: 100
        });

        if (res.success) {
            const xAddr = typeof pool.token_x === 'object' ? pool.token_x?.address : pool.token_x;
            const yAddr = typeof pool.token_y === 'object' ? pool.token_y?.address : pool.token_y;
            const finalBaseMint = xAddr === "So11111111111111111111111111111111111111112" ? yAddr : xAddr;
            state.trackPosition(res.position, { 
                pool: pool.pool, 
                pair: pool.name, 
                autoSwap,
                autoReentry,
                tpMode: "static",
                baseMint: finalBaseMint,
                amountSol: amountSol
            });
            telegram.notifyDeploy({ pair: pool.name, amountSol, position: res.position });

            // 🔥 Store to Supermemory
            await memory.addMemory(`User opened VOLATILITY x${volMult} position on ${pool.name} with ${amountSol} SOL. AutoSwap: ${autoSwap}, AutoReentry: ${autoReentry}`, ["deployment", "volatility", "success", pool.name]);
        } else {
            console.log(`❌ Eksekusi Gagal: ${res.error}`);
            await memory.addMemory(`Failed to deploy VOLATILITY on ${pool.name}: ${res.error}`, ["deployment", "failure"]);
        }
    } catch (e) {
        console.log(`❌ Error Sistem saat Deploy: ${e.message}`);
    }
}

async function manualDeploy(ca, amountSol, manualAth = null, manualAtl = null, autoSwap = false, autoReentry = false, strategy = "fibo", volMult = 5) {
  try {
    const searchResult = await dlmm.searchPools({ query: ca, limit: 10 });
    const solPools = (searchResult.pools || []).filter(p => p.name.includes("-SOL") || p.name.includes("SOL-"));
    
    if (solPools.length === 0) {
        console.log(`❌ Pool SOL tidak ditemukan untuk CA: ${ca}`);
        return;
    }

    if (strategy === "vol") {
        await executeVolDeploy(solPools[0], amountSol, volMult, autoSwap, autoReentry);
        return;
    }

    console.log(`🔎 Fibonacci Strategy for ${ca.slice(0,8)}...`);
    const anchors = await getAbsoluteAnchors(ca, solPools[0].pool);
    const range = anchors.ath - anchors.atl;
    const entryPrice = anchors.ath - (range * 0.236);
    const bottomLevel = anchors.athMcapUsd >= 650000 ? 0.786 : 0.887;
    const bottomPrice = anchors.ath - (range * bottomLevel);

    const activeBin = await dlmm.getActiveBin({ pool_address: solPools[0].pool });
    const currentPrice = Number(activeBin.price);

    if (currentPrice <= entryPrice) {
        await executeFibDeploy(solPools[0], amountSol, currentPrice, bottomPrice, autoSwap, null, bottomLevel, autoReentry, entryPrice);
    } else {
        console.log(`⏳ Price too high: ${currentPrice.toFixed(10)} (Target: < ${entryPrice.toFixed(10)})`);
    }
  } catch (err) { 
    console.log(`❌ Error di manualDeploy: ${err.message}`);
  }
}

/**
 * Main Entry with TUI Integration
 */
async function main() {
  // 1. Initialize TUI only if in TTY
  if (process.stdout.isTTY) {
    tui.initTUI({
      onCommand: async (line) => {
          (async () => {
              const parts = line.trim().split(" ");
              let cmd = parts[0].toLowerCase();
              if (cmd.startsWith("/")) cmd = cmd.slice(1);

              try {
                  switch (cmd) {
                      case "help":
                          tui.tuiLog("Commands: /lp, /top, /status, /close, /tp, /ar, /as, /swap, /lo, /config, /set, /cancel, /exit");
                          break;
                      case "status":
                          const balances = await wallet.getWalletBalances();
                          tui.tuiLog(`💰 Balance: ${balances.sol.toFixed(4)} SOL`);
                          break;
                      case "top":
                          tui.tuiLog("🔍 Scanning for trending Alpha pools...");
                          const topPools = await meteoraTop.getMeteoraTopPools(5);
                          if (topPools.length === 0) {
                              tui.tuiLog("❌ No Alpha candidates found meeting current safety filters.");
                          } else {
                              topPools.forEach((p, i) => {
                                  tui.tuiLog(`[${i+1}] ${p.name} | MC: $${Math.round(p.mcap/1000)}k | Y: ${p.yield.toFixed(1)}% | Score: ${p.score}`);
                              });
                          }
                          break;
                      case "lp":
                          const lpCa = parts[1];
                          if (!lpCa) break;
                          let lpAmt = 0.001;
                          let lpAS = false;
                          let lpAR = false;
                          for (let i = 2; i < parts.length; i++) {
                              const p = parts[i].toUpperCase();
                              if (p === "AS") lpAS = true; else if (p === "AR") lpAR = true;
                              else { const v = parseFloat(p); if (!isNaN(v)) lpAmt = v; }
                          }
                          await manualDeploy(lpCa, lpAmt, null, null, lpAS, lpAR);
                          break;
                      case "close":
                          const cIdx = parseInt(parts[1]) - 1;
                          const cPos = await dlmm.getMyPositions({ force: true });
                          const cTarget = cPos.positions?.[cIdx];
                          if (cTarget) {
                              const pnl = await dlmm.getPositionPnl({ pool_address: cTarget.pool, position_address: cTarget.position });
                              await smartClosePosition(cTarget.position, cTarget.pair, pnl.pnl_pct || 0, pnl.pnl_usd || 0, "TUI Exit");
                          }
                          break;
                      case "as":
                          const asIdx = parseInt(parts[1]) - 1;
                          const asPos = await dlmm.getMyPositions({ force: true });
                          const asT = asPos.positions?.[asIdx];
                          if (asT) {
                              const cur = state.getTrackedPosition(asT.position)?.autoSwap || false;
                              state.updateTrackedPosition(asT.position, { autoSwap: !cur });
                              tui.tuiLog(`✅ AS ${!cur ? 'ON' : 'OFF'} for ${asT.pair}`);
                          }
                          break;
                      case "exit":
                      case "quit":
                          process.exit(0);
                          break;
                      default:
                          tui.tuiLog(`❓ Unknown command: ${cmd}`);
                  }
              } catch (e) {
                  tui.tuiLog(`Error: ${e.message}`);
              } finally {
                  await tui.updateTUI(true);
              }
          })();
      }
    });
  } else {
    console.log("🚀 Running in Headless Mode (No TTY). TUI skipped.");
  }

  await new Promise(r => setTimeout(r, 1000));
  tui.tuiLog("🚀 DeltLP TUI Dashboard Started.");

  setInterval(async () => {
    await runManagementCycle({ silent: true });
  }, 30000);

  telegram.initTelegramBot({
    status: async () => {
        const balances = await wallet.getWalletBalances();
        const posData = await dlmm.getMyPositions({ force: true });
        let msg = `💰 *Balance:* ${balances.sol.toFixed(4)} SOL\n\n📊 *Positions:* ${posData.total_positions}\n`;
        for (const p of (posData.positions || [])) {
            msg += `- ${p.pair}: ${(p.pnl_pct || 0).toFixed(2)}%\n`;
        }
        return msg;
    },
    top: async () => {
        const topPools = await meteoraTop.getMeteoraTopPools(5);
        if (topPools.length === 0) return "❌ No Alpha candidates found.";
        let msg = "🔥 *Top Trending Pools (Alpha Scan):*\n\n";
        topPools.forEach((p, i) => {
            msg += `[${i+1}] ${p.name}\nMC: $${Math.round(p.mcap/1000)}k | Y: ${p.yield.toFixed(1)}% | Score: ${p.score}\nCA: \`${p.mint}\`\n\n`;
        });
        return msg;
    },
    lp: async (ca, amtStr) => {
        const parts = String(amtStr).split(" ");
        let amt = 0.001;
        let as = false, ar = false;
        for (const part of parts) {
            const up = part.toUpperCase();
            if (up === "AS") as = true;
            else if (up === "AR") ar = true;
            else {
                const parsed = parseFloat(part.replace(",", "."));
                if (!isNaN(parsed)) amt = parsed;
            }
        }
        await manualDeploy(ca, amt, null, null, as, ar);
    },
    lp_vol: async (ca, amtStr) => {
        // Simple wrapper for volatility strategy from Telegram
        const parts = String(amtStr).split(" ");
        let amt = 0.001, as = false, ar = false, mult = 5;
        for (const part of parts) {
            const up = part.toUpperCase();
            if (up === "AS") as = true;
            else if (up === "AR") ar = true;
            else if (up.startsWith("M")) mult = parseInt(up.slice(1)) || 5;
            else {
                const parsed = parseFloat(part.replace(",", "."));
                if (!isNaN(parsed)) amt = parsed;
            }
        }
        await manualDeploy(ca, amt, null, null, as, ar, "vol", mult);
    },
    close: async (idx) => {
        const index = parseInt(idx) - 1;
        const allPos = await dlmm.getMyPositions({ force: true });
        const target = allPos.positions?.[index];
        if (!target) return "❌ Position not found.";
        const pnl = await dlmm.getPositionPnl({ pool_address: target.pool, position_address: target.position });
        await smartClosePosition(target.position, target.pair, pnl.pnl_pct || 0, pnl.pnl_usd || 0, "TG Exit");
        return "✅ Success.";
    },
    tp: async (idx, val) => {
        const index = parseInt(idx) - 1;
        const allPos = await dlmm.getMyPositions({ force: true });
        const target = allPos.positions?.[index];
        if (!target) return "❌ Not found.";
        state.updateTrackedPosition(target.position, { takeProfitPct: parseFloat(val) });
        return `✅ TP set to ${val}% for ${target.pair}`;
    },
    as: async (idx) => {
        const index = parseInt(idx) - 1;
        const allPos = await dlmm.getMyPositions({ force: true });
        const target = allPos.positions?.[index];
        if (!target) return "❌ Not found.";
        const cur = state.getTrackedPosition(target.position)?.autoSwap || false;
        state.updateTrackedPosition(target.position, { autoSwap: !cur });
        return `✅ AS ${!cur ? 'ON' : 'OFF'} for ${target.pair}`;
    },
    ar: async (idx) => {
        const index = parseInt(idx) - 1;
        const allPos = await dlmm.getMyPositions({ force: true });
        const target = allPos.positions?.[index];
        if (!target) return "❌ Not found.";
        const cur = state.getTrackedPosition(target.position)?.autoReentry || false;
        state.updateTrackedPosition(target.position, { autoReentry: !cur });
        return `✅ AR ${!cur ? 'ON' : 'OFF'} for ${target.pair}`;
    },
    swap: async (ca) => {
        const balances = await wallet.getWalletBalances();
        const tok = balances.tokens?.find(t => t.mint === ca || t.symbol === ca);
        if (!tok || tok.balance <= 0) return "❌ No balance.";
        await wallet.swapToken({ input_mint: tok.mint, output_mint: "So11111111111111111111111111111111111111112", amount: tok.balance });
        return `✅ Swapping ${tok.balance} ${tok.symbol || 'tokens'}...`;
    },
    lo: async (ca, amtStr) => {
        const amt = parseFloat(amtStr) || 0.001;
        await lo.executeLimitOrder(ca, amt, "BA");
    },
    cancel: async (ca) => {
        const success = cancelOrder(ca);
        return success ? `✅ Monitoring for ${ca.slice(0,8)} cancelled.` : "❌ Not found in pending orders.";
    },
    set: async (key, val) => {
        const v = parseFloat(val);
        if (key === "tp") { config.management.takeProfitPct = v; return `✅ Global TP: ${v}%`; }
        if (key === "sl") { config.management.stopLossPct = v; return `✅ Global SL: ${v}%`; }
        if (key === "fee") { config.management.feeEnabled = (val === "on"); return `✅ Fee ${val.toUpperCase()}`; }
        return "❌ Unknown key.";
    },
    setwallet: async (pKey) => {
        return wallet.updateWalletKey(pKey);
    },
    config: async () => {
        const feeStatus = config.management.feeEnabled ? "ON" : "OFF";
        const text = `⚙️ *DeltLP Global Config*\n\n💰 *TP:* ${config.management.takeProfitPct}%\n📉 *SL:* ${config.management.stopLossPct}%\n💎 *Fee:* ${feeStatus}\n🛡️ *Max Cap:* ${config.management.globalMaxCapSol} SOL`;
        const buttons = {
            inline_keyboard: [
                [{ text: "📈 Set TP", callback_data: "c_set_tp" }, { text: "📉 Set SL", callback_data: "c_set_sl" }],
                [{ text: feeStatus === "ON" ? "💎 Fee: ON" : "💎 Fee: OFF", callback_data: feeStatus === "ON" ? "c_fee_off" : "c_fee_on" }],
                [{ text: "🛡️ Set Max Cap", callback_data: "c_set_cap" }, { text: "🔑 Set Wallet", callback_data: "c_set_wallet" }],
                [{ text: "⬅️ Back to Menu", callback_data: "m_m" }]
            ]
        };
        return { text, buttons };
    }
  });
}

main().catch((err) => {
  log("error", `Fatal error: ${err.message}`);
  process.exit(1);
});
