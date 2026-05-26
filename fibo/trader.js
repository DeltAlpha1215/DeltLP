import "dotenv/config";
import readline from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { log } from "../logger.js";
import { getPoolDetail } from "../tools/screening.js";
import { deployPosition, getActiveBin, getPositionPnl, closePosition, searchPools } from "../tools/dlmm.js";
import { getWalletBalances } from "../tools/wallet.js";
import { agentDeltLPJson, getAgentDeltLPHeaders } from "../tools/agent-deltlp.js";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question, defaultVal) {
  return new Promise((resolve) => {
    const hint = defaultVal !== undefined && defaultVal !== "" ? ` (default: ${defaultVal})` : "";
    rl.question(`${question}${hint}: `, (ans) => {
      const trimmed = ans.trim();
      resolve(trimmed === "" ? defaultVal : trimmed);
    });
  });
}

function askNum(question, defaultVal) {
  return new Promise(async (resolve) => {
    while (true) {
      const raw = await ask(question, defaultVal);
      const n = parseFloat(raw);
      if (isNaN(n)) {
        console.log("  ⚠ Masukkan angka yang valid.");
        continue;
      }
      resolve(n);
      break;
    }
  });
}

async function fetchOHLCV(mint, interval, candles = 100) {
  try {
    const normalizedInterval = String(interval || "15_MINUTE").trim().toUpperCase();
    const search = new URLSearchParams({
      interval: normalizedInterval,
      candles: String(candles),
    });
    
    const pathname = `/chart-indicators/${mint}?${search.toString()}`;
    const response = await agentDeltLPJson(pathname, {
      headers: getAgentDeltLPHeaders(),
      retry: { maxAttempts: 3, maxElapsedMs: 10000 }
    });
    
    return response?.ohlcv || [];
  } catch (e) {
    return [];
  }
}

function calculateFibLevel(high, low, level) {
    const diff = high - low;
    return high - (diff * level);
}

async function startTrading() {
    console.clear();
    console.log("===============================================");
    console.log("   DELTLP FIBONACCI AUTO-ENTRY BOT (v1.1)    ");
    console.log("===============================================\n");
    
    // Check Env
    if (!process.env.RPC_URL || !process.env.WALLET_PRIVATE_KEY) {
        console.log("❌ ERROR: RPC_URL atau WALLET_PRIVATE_KEY belum diatur di .env");
        console.log("Jalankan 'npm run setup' terlebih dahulu.");
        process.exit(1);
    }

    const ca = await ask("Masukkan Contract Address (CA) Koin");
    const timeframe = await ask("Pilih Timeframe (5m, 15m, 1h, 4h)", "15m");
    const lookback = await askNum("Lookback Candles (untuk cari High/Low)", 50);
    const fibLevel = await askNum("Level Fibonacci Target (contoh: 0.618)", 0.618);
    const amountSol = await askNum("Jumlah SOL untuk Deploy", 0.1);
    const slippage = await askNum("Toleransi Slippage (%)", 5);

    // Initial Balance Check
    console.log("\n🔍 Mengecek saldo dompet...");
    if (process.env.DRY_RUN === "true") {
        console.log("⚠️  DRY RUN AKTIF: Melewati pengecekan saldo.");
    } else {
        const balances = await getWalletBalances();
        if (balances.error) {
            console.log(`❌ Gagal cek saldo: ${balances.error}`);
            process.exit(1);
        }
        
        console.log(`✅ Saldo saat ini: ${balances.sol.toFixed(4)} SOL`);
        if (balances.sol < (amountSol + 0.02)) {
            console.log(`❌ Saldo tidak cukup! Butuh minimal ${(amountSol + 0.02).toFixed(4)} SOL (termasuk gas).`);
            process.exit(1);
        }
    }

    console.log("\n🔎 Mencari pool terbaik di Meteora...");
    const searchResult = await searchPools({ query: ca, limit: 10 });
    if (!searchResult.pools || searchResult.pools.length === 0) {
        console.log("❌ ERROR: Tidak ada pool DLMM ditemukan untuk CA ini.");
        process.exit(1);
    }

    let bestPool = null;
    let maxRatio = -1;

    for (const p of searchResult.pools) {
        try {
            const detail = await getPoolDetail({ pool_address: p.pool, timeframe: timeframe });
            const ratio = detail.fee_active_tvl_ratio || 0;
            if (ratio > maxRatio) {
                maxRatio = ratio;
                bestPool = detail;
            }
        } catch (e) { continue; }
    }

    if (!bestPool) {
        bestPool = searchResult.pools[0];
        console.log(`⚠️  Rasio Fee tidak ditemukan. Menggunakan pool TVL tertinggi: ${bestPool.pool}`);
    } else {
        console.log(`✅ Pool Terpilih: ${bestPool.name}`);
        console.log(`📈 Fee/TVL Ratio: ${(bestPool.fee_active_tvl_ratio * 100).toFixed(2)}%`);
    }

    console.log("\n===============================================");
    console.log("🚀 BOT AKTIF - MEMANTAU HARGA...");
    console.log("Target: Harga menyentuh level Fibonacci " + fibLevel);
    console.log("===============================================\n");

    const intervalMap = { "5m": "5_MINUTE", "15m": "15_MINUTE", "1h": "1_HOUR", "4h": "4_HOUR" };
    const apiInterval = intervalMap[timeframe] || "15_MINUTE";

    let errorCount = 0;

    while (true) {
        try {
            const ohlcv = await fetchOHLCV(ca, apiInterval, lookback);
            if (!ohlcv || ohlcv.length === 0) {
                process.stdout.write(`\r[${new Date().toLocaleTimeString()}] Menunggu data grafik...`);
                await new Promise(r => setTimeout(r, 10000));
                continue;
            }

            const highs = ohlcv.map(c => c.high);
            const lows = ohlcv.map(c => c.low);
            const high = Math.max(...highs);
            const low = Math.min(...lows);
            
            const entryPrice = calculateFibLevel(high, low, fibLevel);
            
            const activeBin = await getActiveBin({ pool_address: bestPool.pool });
            const currentPrice = activeBin.price;

            // Calculate progress
            const distance = ((currentPrice - entryPrice) / entryPrice) * 100;
            const statusLabel = distance <= 0 ? "ENTRY POINT!" : `+${distance.toFixed(2)}% dari target`;

            process.stdout.write(`\rPrice: ${currentPrice.toFixed(10)} | Target: ${entryPrice.toFixed(10)} | Stat: ${statusLabel}   `);

            if (currentPrice <= entryPrice) {
                console.log("\n\n🎯 TARGET TERCAPAI!");
                console.log(`Harga Target: ${entryPrice.toFixed(10)}`);
                console.log(`Harga Sekarang: ${currentPrice.toFixed(10)}`);
                console.log(`Eksekusi: Deploy ${amountSol} SOL ke ${bestPool.name}...`);
                
                const result = await deployPosition({
                    pool_address: bestPool.pool,
                    amount_sol: amountSol,
                    strategy: "bid_ask",
                    bins_below: 69,
                    bins_above: 0
                });

                if (result.success) {
                    console.log("\n✅ BERHASIL! Posisi telah dibuka.");
                    const positionAddress = result.position;
                    console.log(`Transaction Hash: ${result.txs ? result.txs[0] : 'Lihat di dompet'}`);
                    
                    const tpTarget = config.management.takeProfitPct || 5;
                    const slTarget = config.management.stopLossPct || -15;

                    console.log("\n===============================================");
                    console.log(`💰 MODE MANAGEMENT - SESUAI CONFIG DELTLP`);
                    console.log(`Target TP: ${tpTarget}% | Target SL: ${slTarget}%`);
                    console.log("===============================================\n");

                    while (true) {
                        try {
                            const pnlData = await getPositionPnl({ 
                                pool_address: bestPool.pool, 
                                position_address: positionAddress 
                            });

                            if (pnlData.error) {
                                process.stdout.write(`\r[${new Date().toLocaleTimeString()}] Menunggu data PnL...`);
                            } else {
                                const pnl = pnlData.pnl_pct || 0;
                                process.stdout.write(`\rPnL: ${pnl.toFixed(2)}% | TP: ${tpTarget}% | SL: ${slTarget}%   `);

                                // Cek Take Profit
                                if (pnl >= tpTarget) {
                                    console.log(`\n\n💰 TARGET TP ${tpTarget}% TERCAPAI!`);
                                    const closeResult = await closePosition({
                                        position_address: positionAddress,
                                        reason: `Fibonacci Auto-TP ${tpTarget}%`
                                    });
                                    if (closeResult.success) console.log("✅ Posisi ditutup (Profit).");
                                    break; 
                                }

                                // Cek Stop Loss
                                if (pnl <= slTarget) {
                                    console.log(`\n\n⚠️ TARGET SL ${slTarget}% TERCAPAI!`);
                                    const closeResult = await closePosition({
                                        position_address: positionAddress,
                                        reason: `Fibonacci Auto-SL ${slTarget}%`
                                    });
                                    if (closeResult.success) console.log("✅ Posisi ditutup (Stop Loss).");
                                    break;
                                }
                            }
                        } catch (e) {
                            process.stdout.write(`\r⚠️ Error PnL: ${e.message.slice(0, 30)}...`);
                        }
                        await new Promise(r => setTimeout(r, 15000));
                    }
                } else {
                    console.log(`\n❌ GAGAL: ${result.error}`);
                }
                break; 
            }
            errorCount = 0; // Reset error if successful
        } catch (e) {
            errorCount++;
            if (errorCount > 5) {
                console.log(`\n⚠️ Terlalu banyak error berturut-turut: ${e.message}`);
                console.log("Mencoba tetap berjalan...");
            }
        }
        await new Promise(r => setTimeout(r, 10000)); 
    }
    rl.close();
}

startTrading();
