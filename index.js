import "dotenv/config";
import readline from "readline";

// Suppress non-fatal bigint warning
const originalWarn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('bigint: Failed to load bindings')) return;
  originalWarn(...args);
};

import { log } from "./logger.js";
import { config } from "./config.js";
import { 
  getMyPositions, 
  getPositionPnl, 
  closePosition, 
  deployPosition,
  getActiveBin,
  searchPools
} from "./tools/dlmm.js";
import { confirmIndicatorPreset } from "./tools/chart-indicators.js";
import { getPoolDetail } from "./tools/screening.js";
import { getWalletBalances, swapToken } from "./tools/wallet.js";
import { notifyClose, notifyDeploy, notifyError } from "./telegram.js";
import { trackPosition, untrackPosition, getTrackedPosition, updateTrackedPosition } from "./state.js";
import { agentDeltLPJson, getAgentDeltLPHeaders } from "./tools/agent-deltlp.js";
import { initTelegramBot } from "./telegram.js";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
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
 * Fetch OHLCV data from Jupiter API for deep history
 */
async function fetchOHLCV(mint) {
  try {
    const meteoraUrl = `https://dlmm.datapi.meteora.ag/pools?query=${mint}&sort_by=tvl:desc`;
    const searchRes = await fetch(meteoraUrl);
    const searchJson = await searchRes.json();
    const poolAddr = searchJson.pools?.[0]?.pool;
    if (!poolAddr) return [];
    const historyUrl = `https://dlmm.datapi.meteora.ag/pools/${poolAddr}/ohlcv?interval=1440`;
    const res = await fetch(historyUrl);
    if (!res.ok) return [];
    const json = await res.json();
    return json.data || [];
  } catch (e) {
    return [];
  }
}

/**
 * Mendapatkan ATH/ATL Global (Sejak Lahir) via Jupiter Data API
 */
async function getAbsoluteAnchors(ca, poolAddr) {
    console.log("🔍 Mencari Inception Price (Harga Lahir) secara otomatis...");
    let ath = 0;
    let atl = 0.000000001; 
    let supply = 0;

    try {
        const assetJson = await fetchWithLog(`https://datapi.jup.ag/v1/assets/search?query=${ca}`, "Jupiter Assets");
        const token = Array.isArray(assetJson) ? assetJson[0] : assetJson;
        if (token && token.createdAt) {
            supply = Number(token.totalSupply || token.circSupply || 0);
            const priceJson = await fetchWithLog(`https://price.jup.ag/v6/price/history?ids=${ca}&vsToken=So11111111111111111111111111111111111111112`, "Jupiter Price History");
            const history = priceJson.data || [];
            if (history.length > 0) {
                ath = Math.max(...history.map(h => Number(h.price)));
                atl = Math.min(...history.map(h => Number(h.price)));
                console.log("✅ Berhasil menemukan ATL Inception via Jupiter!");
            }
        }
    } catch (e) { }

    if (atl > 0.000001) { 
        try {
            const dsJson = await fetchWithLog(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, "DexScreener");
            if (dsJson.pairs) {
                const sortedPairs = dsJson.pairs.sort((a, b) => (a.pairCreatedAt || 9999999999) - (b.pairCreatedAt || 9999999999));
                const inceptionPair = sortedPairs[0];
                const dsPrice = Number(inceptionPair.priceNative || 0);
                if (dsPrice < atl || atl === 0.000000001) atl = dsPrice;
                if (atl > 0.000001) atl = 0.000000044; 
                
                // Jika supply masih 0 dari Jupiter, ambil dari DS
                if (!supply) {
                    const fdv = Number(inceptionPair.fdv || 0);
                    const currentPriceDs = Number(inceptionPair.priceNative || 0);
                    if (fdv && currentPriceDs) supply = fdv / currentPriceDs;
                }
            }
        } catch {}
    }

    try {
        const meteoraData = await getDeepHistoryAnchors_Meteora(poolAddr);
        if (meteoraData && meteoraData.ath > ath) ath = meteoraData.ath;
    } catch {}
    return { ath, atl, supply };
}

async function getSolPriceUsd() {
    try {
        const res = await fetch("https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112");
        const json = await res.json();
        return parseFloat(json.data["So11111111111111111111111111111111111111112"]?.price || 150);
    } catch {
        return 150; // Fallback
    }
}

async function getDeepHistoryAnchors_Meteora(poolAddr) {
    let allData = [];
    let lastTimestamp = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i++) {
        const url = `https://dlmm.datapi.meteora.ag/pools/${poolAddr}/ohlcv?interval=1440&time_to=${lastTimestamp}`;
        try {
            const res = await fetch(url);
            const json = await res.json();
            const data = json.data || [];
            if (data.length === 0) break;
            allData = [...allData, ...data];
            lastTimestamp = data[0].timestamp - 1;
        } catch { break; }
    }
    if (allData.length === 0) return null;
    return {
        ath: Math.max(...allData.map(c => c.high)),
        atl: Math.min(...allData.map(c => c.low))
    };
}

async function fetchWithLog(url, name) {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        log("error", `Fetch failed for ${name}: ${e.message}`);
        throw e;
    }
}

async function smartClosePosition(positionAddress, pair, pnlPct, pnlUsd, reason) {
    try {
        const tracked = getTrackedPosition(positionAddress);
        const useAutoSwap = tracked?.autoSwap || false;
        const baseMint = tracked?.baseMint;

        console.log(`🚀 [DEBUG] Memulai Smart Close untuk ${pair}...`);
        console.log(`🚀 [DEBUG] Alamat Posisi: ${positionAddress}`);
        console.log(`🚀 [DEBUG] AS Mode: ${useAutoSwap}, Base Mint: ${baseMint}`);

        // 1. Close Posisi di Meteora
        const res = await closePosition({ 
            position_address: positionAddress, 
            skip_swap: useAutoSwap, 
            reason 
        });

        if (!res.success) {
            console.log(`❌ [DEBUG] Gagal di tahap close Meteora: ${res.error}`);
            return false;
        }

        console.log(`✅ [DEBUG] Tahap 1 Sukses: Posisi di Meteora ditutup.`);
        untrackPosition(positionAddress);

        // 2. Prosedur Auto-Swap
        if (useAutoSwap && baseMint) {
            console.log(`🔄 [DEBUG] Melakukan Auto-Swap via Jupiter...`);
            await new Promise(r => setTimeout(r, 5000)); // Tunggu 5 detik agar saldo update

            const performSwap = async (attempt = 1) => {
                const balances = await getWalletBalances();
                const tokenEntry = balances.tokens?.find(t => t.mint === baseMint);
                
                if (tokenEntry && tokenEntry.balance > 0) {
                    console.log(`🗳️ [DEBUG] Swap Attempt ${attempt}: ${tokenEntry.balance} token ${pair} -> SOL`);
                    const swapRes = await swapToken({
                        input_mint: baseMint,
                        output_mint: "So11111111111111111111111111111111111111112",
                        amount: tokenEntry.balance
                    });
                    
                    if (swapRes.success) {
                        console.log(`✅ [DEBUG] Auto-Swap Berhasil pada percobaan ke-${attempt}!`);
                        return true;
                    } else {
                        console.log(`❌ [DEBUG] Auto-Swap Gagal (Attempt ${attempt}): ${swapRes.error}`);
                        return false;
                    }
                }
                console.log(`⚠️ [DEBUG] Token tidak ditemukan di dompet (Attempt ${attempt}).`);
                return false;
            };

            let success = await performSwap(1);
            if (!success) {
                console.log("🔄 [DEBUG] Mencoba swap ulang (Attempt 2) dalam 10 detik...");
                await new Promise(r => setTimeout(r, 10000));
                success = await performSwap(2);
            }

            if (!success) {
                const failMsg = `⚠️ *AUTO-SWAP GAGAL*\n` +
                                `Gagal menukar ${pair} ke SOL secara otomatis.\n` +
                                `Silakan gunakan perintah manual:\n` +
                                `\`/swap ${baseMint}\``;
                await notifyError(failMsg);
            }
        }

        await notifyClose({ pair, pnlPct, pnlUsd });
        return true;

    } catch (err) {
        console.log(`❌ [DEBUG] FATAL ERROR di smartClosePosition: ${err.message}`);
        return false;
    }
}

/**
 * Loop Manajemen Otonom (SL, TP, OOR)
 */
export async function runManagementCycle({ silent = false } = {}) {
  try {
    const posData = await getMyPositions({ force: true });
    const positions = posData.positions || [];
    if (positions.length === 0) return "No open positions.";

    let report = `Checking ${positions.length} positions...\n`;

    for (const pos of positions) {
      if (pos.age_minutes < 5) {
        report += `- ${pos.pair}: Waiting (Age: ${pos.age_minutes}m)\n`;
        continue;
      }

      const pnlData = await getPositionPnl({ pool_address: pos.pool, position_address: pos.position });
      if (pnlData.error) continue;

      const pnl = pnlData.pnl_pct || 0;
      const tp = config.management.takeProfitPct || 5;
      const sl = config.management.stopLossPct || -15;

      report += `- ${pos.pair}: PnL ${pnl.toFixed(2)}% (TP: ${tp}%, SL: ${sl}%)\n`;

      // ─── Bollinger Take Profit (New) ───
      // Jika PnL >= 5% dan harga menyentuh BB Atas TF 15m
      if (pnl >= 5) {
          try {
              const indicatorRes = await confirmIndicatorPreset({
                  mint: pos.baseMint || pos.token_x,
                  side: "exit",
                  preset: "bollinger_reversion", // Preset ini mengecek harga >= upperBand
                  intervals: ["15_MINUTE"]
              });
              
              if (indicatorRes.confirmed) {
                  await smartClosePosition(pos.position, pos.pair, pnl, pnlData.pnl_usd, `BB Upper Hit (15m) + PnL ${pnl.toFixed(2)}%`);
                  continue;
              }
          } catch (e) {
              log("error", `BB Check failed for ${pos.pair}: ${e.message}`);
          }
      }

      const tracked = getTrackedPosition(pos.position);
      if (pnl >= tp && !tracked?.tpDisabled) {
        await smartClosePosition(pos.position, pos.pair, pnl, pnlData.pnl_usd, `Auto-TP ${tp}%`);
      } 
      else if (pnl <= sl) {
        await smartClosePosition(pos.position, pos.pair, pnl, pnlData.pnl_usd, `Auto-SL ${sl}%`);
      }
      else if (!pos.in_range) {
        const isOorRight = pos.active_bin > pos.upper_bin;
        const oorTime = pos.minutes_out_of_range || 0;
        if (isOorRight && oorTime >= 10) {
            await smartClosePosition(pos.position, pos.pair, pnl, pnlData.pnl_usd, `Auto-Close OOR Right (${oorTime}m)`);
        }
      }
    }
    return report;
  } catch (err) {
    log("error", `Management cycle error: ${err.message}`);
    return `Error: ${err.message}`;
  }
}

/**
 * Eksekusi Deploy dengan perhitungan Bin Range berdasarkan Fibo 0.786
 * Serta pemilihan strategi Spot vs BA berdasarkan lebar range
 */
async function executeFibDeploy(pool, amountSol, currentPrice, bottomPrice, autoSwap = false, baseMint = null, bottomLevel = 0.786, autoReentry = false) {
    console.log(`🚀 HARGA MASUK TARGET! Menghitung bin range ke Fibo ${bottomLevel}...`);
    
    // --- FINAL BALANCE CHECK ---
    const balances = await getWalletBalances();
    const safetyMargin = 0.05;
    if (balances.sol < (amountSol + safetyMargin)) {
        console.log(`❌ GAGAL: Saldo SOL tidak cukup untuk eksekusi final (${balances.sol.toFixed(4)} SOL).`);
        await notifyError(`⚠️ *EXECUTION ABORTED*\nSaldo tidak cukup untuk membuka posisi ${pool.name} saat target tercapai.`);
        return;
    }

    // Hitung lebar range dalam persen
    const rangePct = Math.abs((currentPrice - bottomPrice) / currentPrice * 100);
    
    // Tentukan list deployment (untuk mendukung split strategy)
    let deployments = [];

    if (rangePct >= 20 && rangePct <= 30) {
        // STRATEGI HYBRID: 70% BA, 30% Spot
        deployments.push({ strategy: "bid_ask", pct: 0.7, label: "Hybrid BA (70%)" });
        deployments.push({ strategy: "spot", pct: 0.3, label: "Hybrid Spot (30%)" });
    } else {
        // STRATEGI SINGLE
        const chosenStrategy = rangePct < 20 ? "spot" : "bid_ask";
        deployments.push({ strategy: chosenStrategy, pct: 1.0, label: chosenStrategy.toUpperCase() });
    }

    const binStep = Number(pool.bin_step || pool.binStep || 100);
    const priceRatio = bottomPrice / currentPrice;
    const binsNeeded = Math.abs(Math.round(Math.log(priceRatio) / (binStep * Math.log(1.0001))));
    const finalBins = Math.max(10, Math.min(400, binsNeeded));

    console.log(`-----------------------------------------------`);
    console.log(`📊 ANALISIS STRATEGI:`);
    console.log(`- Lebar Range Fibo: ${rangePct.toFixed(2)}%`);
    console.log(`- Eksekusi: ${deployments.map(d => d.label).join(" + ")}`);
    console.log(`- Bin Step: ${binStep} | Bins: ${finalBins} | AS Mode: ${autoSwap ? 'ON' : 'OFF'} | AR Mode: ${autoReentry ? 'ON' : 'OFF'}`);
    console.log(`-----------------------------------------------`);

    let mainPositionAddress = null;
    for (const d of deployments) {
        const deployAmount = amountSol * d.pct;
        
        if (!mainPositionAddress) {
            // TRANSKASI 1: Buka Posisi Utama (70% atau 100%)
            console.log(`🚀 Deploying ${d.label}: ${deployAmount.toFixed(4)} SOL...`);
            const res = await deployPosition({
                pool_address: pool.pool,
                amount_sol: deployAmount,
                strategy: d.strategy,
                bins_below: finalBins,
                bins_above: 0,
                volatility: 100
            });

            if (res.success || res.dry_run) {
                if (res.dry_run) {
                    console.log(`⚠️  DRY RUN BERHASIL untuk ${d.label}`);
                    return; // Keluar jika dry run
                } else {
                    mainPositionAddress = res.position;
                    console.log(`✅ BERHASIL! Posisi dibuka: ${mainPositionAddress}`);
                    trackPosition(mainPositionAddress, { 
                        pool: pool.pool, 
                        pair: pool.name, 
                        autoSwap,
                        autoReentry,
                        baseMint: baseMint || pool.token_x,
                        amountSol // Simpan amount_sol untuk reentry nanti
                    });
                    notifyDeploy({ pair: `${pool.name} (${d.strategy})`, amountSol: deployAmount, position: mainPositionAddress });
                }
            } else {
                console.log(`❌ GAGAL Deploy Utama: ${res.error}`);
                return; // Stop jika gagal buka posisi awal
            }
        } else {
            // TRANSAKSI 2: Tambah Likuiditas ke Posisi yang Sudah Ada (30%)
            console.log(`➕ Menambah ${d.label} ke posisi ${mainPositionAddress.slice(0,8)}...`);
            
            // Menggunakan deployPosition dengan parameter position_address untuk trigger 'add liquidity'
            const res = await deployPosition({
                pool_address: pool.pool,
                position_address: mainPositionAddress, // Kirim ID posisi yang sudah ada
                amount_sol: deployAmount,
                strategy: d.strategy,
                bins_below: finalBins,
                bins_above: 0,
                volatility: 100
            });

            if (res.success) {
                console.log(`✅ BERHASIL menambah ${d.label}!`);
                // Update track data jika perlu
            } else {
                console.log(`❌ GAGAL menambah likuiditas: ${res.error}`);
            }
        }
        
        // Delay singkat antar deployment
        if (deployments.length > 1) await new Promise(r => setTimeout(r, 2000));
    }
}

/**
 * Loop pemantauan harga sampai menyentuh Fibo 0.236
 */
async function monitorAndDeploy(ca, pool, amountSol, entryPrice, bottomPrice, ath, atl, autoSwap = false, baseMint = null, bottomLevel = 0.786, supply = 0, autoReentry = false, isAlreadyDeployed = false) {
    console.log(`\n👀 Memulai pemantauan harga live untuk ${pool.name} (AS: ${autoSwap}, AR: ${autoReentry})...`);
    let currentAth = ath;
    let currentEntry = entryPrice;
    let currentBottom = bottomPrice;
    let isDeployed = isAlreadyDeployed;

    const interval = setInterval(async () => {
        try {
            const activeBin = await getActiveBin({ pool_address: pool.pool });
            const currentPrice = Number(activeBin.price);

            // LOGIKA AR (AUTO-REENTRY)
            if (currentPrice > currentAth) {
                currentAth = currentPrice;
                const range = currentAth - atl;
                currentEntry = currentAth - (range * 0.236);
                currentBottom = currentAth - (range * bottomLevel);

                if (autoReentry) {
                    console.log(`\n🚀 [AR] NEW ATH DETECTED: ${currentAth.toFixed(10)}`);
                    
                    if (isDeployed) {
                        // Cari posisi yang sedang terbuka untuk CA ini
                        const posData = await getMyPositions({ force: true });
                        const existingPos = posData.positions?.find(p => 
                            (p.baseMint === baseMint || p.token_x === baseMint) && 
                            getTrackedPosition(p.position)?.autoReentry
                        );

                        if (existingPos) {
                            console.log(`🔄 [AR] Menutup posisi lama ${existingPos.position.slice(0,8)}...`);
                            const pnlData = await getPositionPnl({ pool_address: existingPos.pool, position_address: existingPos.position });
                            
                            // Close posisi lama (force swap ke SOL jika AS aktif)
                            const closed = await smartClosePosition(
                                existingPos.position, 
                                existingPos.pair, 
                                pnlData.pnl_pct || 0, 
                                pnlData.pnl_usd || 0, 
                                "AR: New ATH Reset"
                            );

                            if (closed) {
                                console.log(`✅ [AR] Posisi lama ditutup. Menunggu re-entry di level 0.236 yang baru...`);
                                isDeployed = false; // Reset status agar bisa masuk lagi
                            }
                        } else {
                            // Jika ternyata posisi sudah tertutup (misal kena SL/TP), kita reset juga
                            isDeployed = false;
                        }
                    }
                }
            }

            if (!isDeployed) {
                process.stdout.write(`\r[Monitor ${pool.name}] Harga: ${currentPrice.toFixed(10)} | Target: < ${currentEntry.toFixed(10)}   `);
                if (currentPrice <= currentEntry) {
                    console.log(`\n\n🎯 ENTRY POINT TERCAPAI!`);
                    isDeployed = true;
                    
                    if (!autoReentry) {
                        clearInterval(interval);
                        pendingOrders.delete(ca);
                    }
                    
                    await executeFibDeploy(pool, amountSol, currentPrice, currentBottom, autoSwap, baseMint, bottomLevel, autoReentry);
                    process.stdout.write("\nDeltLP> ");
                }
            } else if (autoReentry) {
                process.stdout.write(`\r[AR Monitor ${pool.name}] Harga: ${currentPrice.toFixed(10)} | ATH saat ini: ${currentAth.toFixed(10)}   `);
            }

        } catch (e) { }
    }, 15000);
    pendingOrders.set(ca, { interval, poolName: pool.name });
}

/**
 * Fungsi Deploy Manual via CA dengan Strategi Fibonacci & Optimasi Pool
 */
async function manualDeploy(ca, amountSol, manualAth = null, manualAtl = null, autoSwap = false, autoReentry = false) {
  try {
    console.log(`\n🔎 MENGGUNAKAN STRATEGI FIBONACCI (AS Mode: ${autoSwap}, AR Mode: ${autoReentry})`);
    
    // --- BALANCE CHECK ---
    const balances = await getWalletBalances();
    const safetyMargin = 0.05; // Cadangan untuk gas & rent posisi
    if (balances.sol < (amountSol + safetyMargin)) {
        const msg = `❌ *SALDO TIDAK CUKUP*\n` +
                    `Saldo: ${balances.sol.toFixed(4)} SOL\n` +
                    `Dibutuhkan: ${amountSol} + ${safetyMargin} (cadangan) SOL\n` +
                    `Gagal mengeksekusi buy.`;
        await notifyError(msg);
        console.log(`❌ GAGAL: Saldo SOL tidak mencukupi (${balances.sol.toFixed(4)} SOL).`);
        return;
    }

    // --- GLOBAL MAX CAP CHECK ---
    const maxCap = config.management.globalMaxCapSol || 1.0;
    const currentPositions = await getMyPositions({ force: true });
    
    // Hitung total SOL yang sedang "war" (dipakai di LP)
    let totalDeployedSol = 0;
    currentPositions.positions?.forEach(p => {
        totalDeployedSol += (p.total_usd / 85); // Estimasi kasar SOL (USD / Harga SOL)
        // Cara lebih akurat jika API menyediakan amount_sol
    });

    if (totalDeployedSol + amountSol > maxCap) {
        const msg = `🛑 *GLOBAL CAP REACHED*\n` +
                    `Total SOL terpakai: ${totalDeployedSol.toFixed(4)} SOL\n` +
                    `Batas Maksimal: ${maxCap.toFixed(2)} SOL\n` +
                    `Gagal menambah ${amountSol} SOL.`;
        await notifyError(msg);
        console.log(`❌ GAGAL: Melampaui Global Max Cap (${maxCap} SOL).`);
        return;
    }
    // ----------------------------

    console.log(`🔎 CA: ${ca}`);
    const searchResult = await searchPools({ query: ca, limit: 10 });
    const solPools = (searchResult.pools || []).filter(p => p.name.includes("-SOL") || p.name.includes("SOL-"));
    if (solPools.length === 0) {
        console.log("❌ Tidak ditemukan pool SOL.");
        return;
    }

    let ath, atl, supply;
    if (manualAth && manualAtl) {
        ath = parseFloat(manualAth);
        atl = parseFloat(manualAtl);
        supply = 0; // Unknown if manual
    } else {
        const anchors = await getAbsoluteAnchors(ca, solPools[0].pool);
        ath = anchors.ath;
        atl = anchors.atl;
        supply = anchors.supply;
    }
    
    // Ambil harga SOL saat ini untuk hitung MCap USD
    const solPriceUsd = await getSolPriceUsd();
    const athMcapUsd = ath * supply * solPriceUsd;
    const bottomLevel = (athMcapUsd > 0 && athMcapUsd < 650000) ? 0.887 : 0.786;

    const range = ath - atl;
    const entryPrice = ath - (range * 0.236);
    const bottomPrice = ath - (range * bottomLevel);

    let bestPool = null;
    let maxBins = 0;
    for (const p of solPools) {
        const bStep = Number(p.bin_step || p.binStep || p.pool_config?.bin_step || 100);
        const estBins = Math.abs(Math.round(Math.log(bottomPrice / entryPrice) / (bStep * Math.log(1.0001))));
        if (estBins > maxBins || !bestPool) {
            maxBins = estBins;
            bestPool = { ...p, bin_step: bStep };
        }
    }

    console.log(`📡 Memverifikasi detail resmi kolam ${bestPool.pool.slice(0,8)}...`);
    const detailJson = await fetchWithLog(`https://dlmm.datapi.meteora.ag/pools/${bestPool.pool}`, "Meteora Detail");
    const officialBinStep = Number(detailJson.pool_config?.bin_step || detailJson.bin_step || bestPool.bin_step);
    const officialPrice = Number(detailJson.current_price || 0);
    const baseMint = detailJson.token_x?.address || detailJson.tokenX || bestPool.token_x;

    bestPool.bin_step = officialBinStep;
    const currentPrice = officialPrice;

    console.log(`-----------------------------------------------`);
    console.log(`✅ Pool Terpilih: ${bestPool.name}`);
    console.log(`📏 Bin Step Resmi: ${bestPool.bin_step}`);
    console.log(`📈 ATH: ${ath.toFixed(10)} (MCap: $${Math.round(athMcapUsd).toLocaleString()})`);
    console.log(`📉 ATL: ${atl.toFixed(10)}`);
    console.log(`🎯 Entry (0.236): < ${entryPrice.toFixed(10)}`);
    console.log(`🛡️ Bottom (${bottomLevel}):   ${bottomPrice.toFixed(10)}`);
    console.log(`💰 Sekarang:          ${currentPrice.toFixed(10)}`);
    console.log(`-----------------------------------------------`);

    // JIKA HARGA SUDAH MASUK TARGET, LANGSUNG DEPLOY, TAPI TETAP JALANKAN MONITORING JIKA AR AKTIF
    let isAlreadyDeployed = false;
    if (currentPrice <= entryPrice) {
        console.log(`🚀 Harga sudah di bawah Fibo 0.236! Mengeksekusi posisi awal...`);
        isAlreadyDeployed = true;
        await executeFibDeploy(bestPool, amountSol, currentPrice, bottomPrice, autoSwap, baseMint, bottomLevel, autoReentry);
        
        if (!autoReentry) {
            // Jika AR tidak aktif, dan sudah di bawah entry, langsung selesai.
            return;
        }
    } else {
        console.log(`⏳ HARGA MASIH TERLALU TINGGI. Menunggu...`);
    }

    // Selalu jalankan loop jika belum deploy ATAU (sudah deploy DAN AR aktif)
    monitorAndDeploy(ca, bestPool, amountSol, entryPrice, bottomPrice, ath, atl, autoSwap, baseMint, bottomLevel, supply, autoReentry, isAlreadyDeployed);

  } catch (err) {
    console.log(`\n❌ ERROR: ${err.message}`);
  }
}

/**
 * REPL Interface
 */
function startREPL() {
  const prompt = () => {
    process.stdout.write("\nDeltLP> ");
  };
  prompt();

  rl.on('SIGINT', () => {
    console.log('\n👋 Menutup DeltLP...');
    process.exit(0);
  });

  rl.on("line", async (line) => {
    const parts = line.trim().split(" ");
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case "buy":
      case "/buy":
        const ca = parts[1];
        let amt = 0.001;
        let isAS = false;
        let isAR = false;
        
        for (let i = 2; i < parts.length; i++) {
            const p = parts[i].toUpperCase();
            if (p === "AS") isAS = true;
            else if (p === "AR") isAR = true;
            else {
                const val = parseFloat(p);
                if (!isNaN(val)) amt = val;
            }
        }

        if (!ca) console.log("Usage: buy <CA> [amount] [AS] [AR]");
        else await manualDeploy(ca, amt, null, null, isAS, isAR);
        break;

      case "status":
      case "/status":
        const balances = await getWalletBalances();
        console.log(`\n💰 Balance: ${balances.sol.toFixed(4)} SOL`);
        const posData = await getMyPositions({ force: true });
        console.log(`📊 Positions: ${posData.total_positions}`);
        const unit = config.management.solMode ? "SOL" : "USD";
        posData.positions?.forEach((p, i) => {
          const tracked = getTrackedPosition(p.position);
          const tpStatus = tracked?.tpDisabled ? 'OFF' : 'ON';
          const arStatus = tracked?.autoReentry ? 'ON' : 'OFF';
          const pnlVal = p.pnl_usd || 0; // pnl_usd holds the value in solMode context
          console.log(`${i+1}. ${p.pair} | Range: ${p.in_range ? 'IN' : 'OOR'} | Age: ${p.age_minutes}m | PnL: ${pnlVal.toFixed(4)} ${unit} (${p.pnl_pct?.toFixed(2) || 0}%) | AS: ${tracked?.autoSwap ? 'ON' : 'OFF'} | AR: ${arStatus} | TP: ${tpStatus}`);
        });
        break;

      case "tp":
      case "/tp":
        const tpMode = parts[1]?.toLowerCase();
        const tpIdx = parseInt(parts[2]) - 1;
        const tpPos = await getMyPositions({ force: true });
        const tpTarget = tpPos.positions?.[tpIdx];
        
        if (!tpTarget || (tpMode !== "on" && tpMode !== "off")) {
            console.log("Usage: tp <on/off> <index_number>");
        } else {
            const isDisabled = tpMode === "off";
            updateTrackedPosition(tpTarget.position, { tpDisabled: isDisabled });
            console.log(`✅ TP Statis untuk ${tpTarget.pair} diatur ke: ${tpMode.toUpperCase()}`);
        }
        break;

      case "ar":
      case "/ar":
        const arMode = parts[1]?.toLowerCase();
        const arIdx = parseInt(parts[2]) - 1;
        const arPosData = await getMyPositions({ force: true });
        const arTarget = arPosData.positions?.[arIdx];
        
        if (!arTarget || (arMode !== "on" && arMode !== "off")) {
            console.log("Usage: ar <on/off> <index_number>");
        } else {
            const isEnabled = arMode === "on";
            updateTrackedPosition(arTarget.position, { autoReentry: isEnabled });
            console.log(`✅ Auto-Reentry untuk ${arTarget.pair} diatur ke: ${arMode.toUpperCase()}`);
        }
        break;

      case "close":
      case "/close":
        const index = parseInt(parts[1]) - 1;
        const allPos = await getMyPositions({ force: true });
        const target = allPos.positions?.[index];
        if (!target) {
          console.log("Usage: close <index_number>");
        } else {
          const pnlData = await getPositionPnl({ pool_address: target.pool, position_address: target.position });
          await smartClosePosition(target.position, target.pair, pnlData.pnl_pct || 0, pnlData.pnl_usd || 0, "Manual Exit");
        }
        break;

      case "cancel":
      case "/cancel":
        const cancelCa = parts[1];
        if (cancelOrder(cancelCa)) console.log(`✅ Pemantauan untuk ${cancelCa} dibatalkan.`);
        else console.log(`❌ CA tidak ditemukan.`);
        break;

      case "as":
      case "/as":
        const asIdx = parseInt(parts[1]) - 1;
        const allPositions = await getMyPositions({ force: true });
        const asTarget = allPositions.positions?.[asIdx];
        if (!asTarget) {
          console.log("Usage: as <index_number>");
        } else {
          console.log(`📡 Mengaktifkan AS untuk ${asTarget.pair}...`);
          const detail = await fetchWithLog(`https://dlmm.datapi.meteora.ag/pools/${asTarget.pool}`, "Meteora Detail");
          const bMint = detail.token_x?.address || detail.tokenX || asTarget.token_x;
          updateTrackedPosition(asTarget.position, { autoSwap: true, baseMint: bMint, pool: asTarget.pool, pair: asTarget.pair });
          console.log(`✅ AS Mode AKTIF untuk ${asTarget.pair}.`);
        }
        break;

      case "swap":
      case "/swap":
        const swapMint = parts[1];
        if (!swapMint) {
            console.log("Usage: swap <Mint_Address>");
        } else {
            console.log(`🔄 Memulai swap manual untuk ${swapMint.slice(0,8)}...`);
            const balances = await getWalletBalances();
            const token = balances.tokens?.find(t => t.mint === swapMint);
            if (!token || token.balance <= 0) {
                console.log("❌ GAGAL: Token tidak ditemukan atau saldo 0.");
            } else {
                const res = await swapToken({
                    input_mint: swapMint,
                    output_mint: "So11111111111111111111111111111111111111112",
                    amount: token.balance
                });
                if (res.success) console.log("✅ Swap Berhasil!");
                else console.log(`❌ Swap Gagal: ${res.error}`);
            }
        }
        break;

      case "manage":
      case "/manage":
        console.log("Running manual management cycle...");
        console.log(await runManagementCycle());
        break;

      case "exit":
      case "quit":
        process.exit(0);
        break;

      case "set":
      case "/set":
        const setKey = parts[1]?.toLowerCase();
        const setVal = parseFloat(parts[2]);
        if (!setKey || isNaN(setVal)) {
            console.log("Usage: set <tp/sl> <percentage_value>");
        } else {
            if (setKey === "tp") {
                config.management.takeProfitPct = setVal;
                console.log(`✅ Global Take Profit diatur ke: ${setVal}%`);
            } else if (setKey === "sl") {
                config.management.stopLossPct = setVal;
                console.log(`✅ Global Stop Loss diatur ke: ${setVal}%`);
            } else {
                console.log("Unknown key. Use 'tp' or 'sl'.");
            }
        }
        break;

      case "config":
      case "/config":
        console.log(`\n⚙️  CURRENT SETTINGS:`);
        console.log(`- Global TP: ${config.management.takeProfitPct}%`);
        console.log(`- Global SL: ${config.management.stopLossPct}%`);
        console.log(`- Max SOL Cap: ${config.management.globalMaxCapSol} SOL`);
        break;

      case "help":
        console.log("\nCommands:");
        console.log("  buy <CA> [amount] [AS] [AR] - Beli koin (AS: Auto-Swap, AR: Auto-Reentry)");
        console.log("  status                      - Cek saldo dan posisi");
        console.log("  set <tp/sl> <value>         - Atur global TP/SL (%)");
        console.log("  config                      - Lihat pengaturan saat ini");
        console.log("  close <no>                  - Tutup posisi");
        console.log("  as <no>                     - Aktifkan Auto-Swap (AS) per posisi");
        console.log("  tp <on/off> <no>            - Aktifkan/Matikan TP Statis per posisi");
        console.log("  swap <CA>                   - Tukar token manual ke SOL");
        console.log("  cancel <CA>                 - Batalkan antrean");
        console.log("  exit                        - Keluar");
        break;

      default:
        if (line.trim() !== "") console.log("Unknown command. Type 'help' for commands.");
        break;
    }
    prompt();
  });
}

/**
 * Main Entry
 */
async function main() {
  console.clear();
  console.log("===============================================");
  console.log("      DeltLP - FIBONACCI HYBRID MODE         ");
  console.log("  (Entry: 0.236 | Range: 0.786 | AS Mode ON)   ");
  console.log("===============================================\n");

  const interval = 30 * 1000; 
  setInterval(async () => {
    log("info", "Running background management cycle...");
    await runManagementCycle({ silent: false });
  }, interval);

  runManagementCycle({ silent: true });

  initTelegramBot({
    status: async () => {
        const balances = await getWalletBalances();
        const posData = await getMyPositions({ force: true });
        const unit = config.management.solMode ? "SOL" : "USD";
        let msg = `💰 *Balance:* ${balances.sol.toFixed(4)} SOL\n\n*Positions:* ${posData.total_positions}\n`;
        posData.positions?.forEach((p, i) => {
            const tr = getTrackedPosition(p.position);
            const tpStat = tr?.tpDisabled ? '❌ OFF' : '✅ ON';
            const arStat = tr?.autoReentry ? '✅ ON' : '❌ OFF';
            const pnlVal = p.pnl_usd || 0;
            msg += `${i+1}. ${p.pair} | ${p.in_range ? '✅ IN' : '⚠️ OOR'} | ${pnlVal.toFixed(4)} ${unit} (${p.pnl_pct?.toFixed(2)}%) | AS: ${tr?.autoSwap ? 'ON' : 'OFF'} | AR: ${arStat} | TP: ${tpStat}\n`;
        });
        return msg;
    },
    buy: async (ca, amtStr) => {
        const parts = String(amtStr).split(" ");
        let amt = 0.001;
        let isAS = false;
        let isAR = false;
        
        for (const part of parts) {
            const p = part.toUpperCase();
            if (p === "AS") {
                isAS = true;
            } else if (p === "AR") {
                isAR = true;
            } else if (part.trim() !== "") {
                const cleanAmt = part.replace(",", ".");
                const parsed = parseFloat(cleanAmt);
                if (!isNaN(parsed)) amt = parsed;
            }
        }

        await manualDeploy(ca, amt, null, null, isAS, isAR);
    },
    close: async (idx) => {
        const index = parseInt(idx) - 1;
        const allPos = await getMyPositions({ force: true });
        const target = allPos.positions?.[index];
        if (!target) return "❌ Index position tidak ditemukan.";
        const pnlData = await getPositionPnl({ pool_address: target.pool, position_address: target.position });
        const success = await smartClosePosition(target.position, target.pair, pnlData.pnl_pct || 0, pnlData.pnl_usd || 0, "Telegram Manual Exit");
        return success ? `✅ ${target.pair} berhasil ditutup!` : "❌ Gagal menutup posisi.";
    },
    cancel: async (ca) => {
        return cancelOrder(ca) ? `✅ Pemantauan untuk CA tersebut telah dibatalkan.` : `❌ CA tidak ditemukan.`;
    },
    as: async (idx) => {
        const index = parseInt(idx) - 1;
        const allPos = await getMyPositions({ force: true });
        const target = allPos.positions?.[index];
        if (!target) return "❌ Index position tidak ditemukan.";
        
        console.log(`📡 Mengambil metadata untuk mengaktifkan AS pada ${target.pair}...`);
        const detailJson = await fetchWithLog(`https://dlmm.datapi.meteora.ag/pools/${target.pool}`, "Meteora Detail");
        const baseMint = detailJson.token_x?.address || detailJson.tokenX || target.token_x;

        updateTrackedPosition(target.position, { 
            autoSwap: true, 
            baseMint,
            pool: target.pool,
            pair: target.pair 
        });

        return `✅ AS Mode AKTIF untuk ${target.pair}. Token akan otomatis di-swap ke SOL saat close.`;
    },
    swap: async (mint) => {
        if (!mint) return "Usage: /swap <Mint_Address>";
        const balances = await getWalletBalances();
        const token = balances.tokens?.find(t => t.mint === mint);
        if (!token || token.balance <= 0) return "❌ GAGAL: Token tidak ditemukan atau saldo 0.";
        
        const res = await swapToken({
            input_mint: mint,
            output_mint: "So11111111111111111111111111111111111111112",
            amount: token.balance
        });
        return res.success ? "✅ Swap Berhasil!" : `❌ Swap Gagal: ${res.error}`;
    },
    tp: async (mode, idx) => {
        const index = parseInt(idx) - 1;
        const allPos = await getMyPositions({ force: true });
        const target = allPos.positions?.[index];
        const lowerMode = mode?.toLowerCase();
        
        if (!target || (lowerMode !== "on" && lowerMode !== "off")) {
            return "Usage: /tp <on/off> <index_number>";
        }
        
        const isDisabled = lowerMode === "off";
        updateTrackedPosition(target.position, { tpDisabled: isDisabled });
        return `✅ TP Statis untuk ${target.pair} diatur ke: ${lowerMode.toUpperCase()}`;
    },
    ar: async (mode, idx) => {
        const index = parseInt(idx) - 1;
        const allPos = await getMyPositions({ force: true });
        const target = allPos.positions?.[index];
        const lowerMode = mode?.toLowerCase();
        
        if (!target || (lowerMode !== "on" && lowerMode !== "off")) {
            return "Usage: /ar <on/off> <index_number>";
        }
        
        const isEnabled = lowerMode === "on";
        updateTrackedPosition(target.position, { autoReentry: isEnabled });
        return `✅ Auto-Reentry untuk ${target.pair} diatur ke: ${lowerMode.toUpperCase()}`;
    },
    set: async (key, val) => {
        const setKey = key?.toLowerCase();
        const setVal = parseFloat(val);
        if (!setKey || isNaN(setVal)) return "Usage: /set <tp/sl> <value>";
        
        if (setKey === "tp") {
            config.management.takeProfitPct = setVal;
            return `✅ Global Take Profit diatur ke: ${setVal}%`;
        } else if (setKey === "sl") {
            config.management.stopLossPct = setVal;
            return `✅ Global Stop Loss diatur ke: ${setVal}%`;
        }
        return "Unknown key. Use 'tp' or 'sl'.";
    },
    config: async () => {
        return `⚙️ *CURRENT SETTINGS:*\n` +
               `- Global TP: ${config.management.takeProfitPct}%\n` +
               `- Global SL: ${config.management.stopLossPct}%\n` +
               `- Max SOL Cap: ${config.management.globalMaxCapSol} SOL`;
    }
  });

  startREPL();
}

main().catch((err) => {
  log("error", `Fatal error: ${err.message}`);
  process.exit(1);
});
