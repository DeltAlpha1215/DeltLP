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
import { getWalletBalances, swapToken } from "./tools/wallet.js";
import { notifyClose, notifyDeploy, notifyError } from "./telegram.js";
import { trackPosition, untrackPosition, getTrackedPosition, updateTrackedPosition } from "./state.js";
import { initTelegramBot } from "./telegram.js";
import { fetchTokenInfo_GMGN, fetchTokenHistory_GMGN } from "./tools/gmgn.js";
import { executeLimitOrder } from "./tools/limit-order.js";

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
        const tokenInfo = await fetchTokenInfo_GMGN(ca);
        if (tokenInfo) {
            supply = tokenInfo.supply;
            athMcapUsd = tokenInfo.ath_mcap_usd;
            athSol = tokenInfo.ath_sol;
            console.log(`✅ Metadata GMGN: ATH ${athSol.toFixed(10)} SOL (MCap: $${Math.round(athMcapUsd).toLocaleString()})`);
            
            // Ambil riwayat dengan sinkronisasi rasio unit (SOL/USD)
            // Gunakan 1h resolution agar ATL lebih presisi (Inception-point)
            const tokenHistory = await fetchTokenHistory_GMGN(ca, tokenInfo.sol_per_usd_ratio, "1h");
            if (tokenHistory) {
                // SINKRONISASI UNIT: Jika history ATH jauh lebih besar dari metadata (misal 10x lipat),
                // kemungkinan besar ada kesalahan unit USD vs SOL di API. Kita pilih yang lebih masuk akal (Metadata).
                const historyAth = tokenHistory.ath;
                if (historyAth > 0 && historyAth < (athSol * 10)) {
                    if (historyAth > athSol) {
                        athSol = historyAth;
                        // UPDATE MCAP: Jika history menemukan peak yang lebih tinggi, update athMcapUsd
                        const solPrice = await getSolPriceUsd();
                        const newMcapUsd = athSol * supply * solPrice;
                        if (newMcapUsd > athMcapUsd) {
                            athMcapUsd = newMcapUsd;
                            console.log(`📈 Peak History baru ditemukan! Update ATH MCap ke: $${Math.round(athMcapUsd).toLocaleString()}`);
                        }
                    }
                }
                
                // Gunakan ATL dari GMGN (Harga lahir yang valid)
                atlSol = tokenHistory.atl;
                
                console.log(`✅ History GMGN: ATH ${athSol.toFixed(10)} SOL | ATL ${atlSol.toFixed(10)} SOL`);
            }
        }
    } catch (e) {
        log("error", `GMGN Data Fetch Failed: ${e.message}`);
    }

    // 2. Final Sanity Check & Sinkronisasi Harga Sekarang
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

    if (!atlSol || atlSol < 0.000000001) atlSol = 0.000000044; // Emergency fallback saja
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

    try {
        const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
        const json = await res.json();
        const price = parseFloat(json.price);
        if (!isNaN(price) && price > 0) return price;
    } catch { }

    return 85; // Fallback darurat
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
        const tracked = getTrackedPosition(positionAddress);
        const useAutoSwap = tracked?.autoSwap || false;
        const baseMint = tracked?.baseMint;

        console.log(`🚀 [DEBUG] Memulai Smart Close untuk ${pair}...`);
        console.log(`🚀 [DEBUG] Alamat Posisi: ${positionAddress}`);
        console.log(`🚀 [DEBUG] AS Mode: ${useAutoSwap}, Base Mint: ${baseMint}`);

        // 1. Close Posisi di Meteora
        let res = await closePosition({ 
            position_address: positionAddress, 
            skip_swap: useAutoSwap, 
            reason 
        });

        // --- VERIFIKASI LANJUTAN UNTUK RPC 429 / TIMEOUT ---
        if (!res.success) {
            console.log(`⚠️ [DEBUG] Tahap close melaporkan error: ${res.error}`);
            
            // Jika error adalah rate limit atau timeout, ada kemungkinan transaksi sebenarnya masuk ke chain
            if (res.error?.includes("429") || res.error?.includes("timeout") || res.error?.includes("Connection rate limits")) {
                console.log(`📡 [DEBUG] Mendeteksi kendala RPC (429/Timeout). Memverifikasi status posisi di blockchain...`);
                await new Promise(r => setTimeout(r, 3000)); // Tunggu 3 detik agar chain update
                
                const posData = await getMyPositions({ force: true });
                const stillExists = posData.positions?.some(p => p.position === positionAddress);
                
                if (!stillExists) {
                    console.log(`✅ [DEBUG] Posisi sudah tidak ditemukan. Transaksi dianggap BERHASIL di-chain.`);
                    res = { success: true }; 
                } else {
                    console.log(`❌ [DEBUG] Posisi masih ada. Close benar-benar gagal.`);
                }
            }
        }

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
      
      const tracked = getTrackedPosition(pos.position);
      const sl = tracked?.stopLossPct || config.management.stopLossPct || -15;
      const tpMode = tracked?.tpMode || "static"; // Default: Static 6%
      let currentLockedPnl = tracked?.lockedPnl || 0;

      // ─── TAKE PROFIT LOGIC BY MODE ───
      
      if (tpMode === "static") {
          // Default: Close at 6%
          if (pnl >= 6) {
              await smartClosePosition(pos.position, pos.pair, pnl, pnlData.pnl_usd, `Static TP @ 6% (Current: ${pnl.toFixed(2)}%)`);
              continue;
          }
      } 
      else if (tpMode === "trailing") {
          // Trailing: Lock 5% at 8% PnL. If PnL > 8%, lock floor at PnL - 3%
          let activation = tracked?.trailingActivationPct || 8;
          
          if (pnl >= activation) {
              // Logic: At 8% (activation), lock 5%. 
              // If PnL is higher (e.g. 10%), lock at PnL - 3% (e.g. 7%).
              // We take the max of 5% and (PnL - 3%).
              const trailingFloor = Math.floor(pnl - 3);
              const newLockedPnl = Math.max(5, trailingFloor);

              if (newLockedPnl > currentLockedPnl) {
                  currentLockedPnl = newLockedPnl;
                  updateTrackedPosition(pos.position, { lockedPnl: currentLockedPnl });
                  console.log(`📈 [TRAILING] ${pos.pair}: New Profit Floor Locked at ${currentLockedPnl}% (Current PnL: ${pnl.toFixed(2)}%)`);
              }
          }

          // Exit if PnL drops to or below locked floor
          if (currentLockedPnl > 0 && pnl <= currentLockedPnl) {
              await smartClosePosition(pos.position, pos.pair, pnl, pnlData.pnl_usd, `Trailing TP @ Floor ${currentLockedPnl}% (Current: ${pnl.toFixed(2)}%)`);
              continue;
          }
      }
      else if (tpMode === "bollinger") {
          // Bollinger: Min 5% PnL + BB Upper Hit (15m)
          if (pnl >= 5) {
              try {
                  const indicatorRes = await confirmIndicatorPreset({
                      mint: pos.baseMint || pos.token_x,
                      side: "exit",
                      preset: "bollinger_reversion",
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
      }

      report += `- ${pos.pair}: PnL ${pnl.toFixed(2)}% [Mode: ${tpMode.toUpperCase()}${tpMode === 'trailing' ? ' Floor: '+currentLockedPnl+'%' : ''}]\n`;

      // ─── Stop Loss & OOR ───
      if (pnl <= sl) {
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
 * Eksekusi Deploy dengan perhitungan Bin Range berdasarkan Fibo
 */
async function executeFibDeploy(pool, amountSol, currentPrice, bottomPrice, autoSwap = false, baseMint = null, bottomLevel = 0.786, autoReentry = false, entryPrice = null) {
    console.log(`🚀 MENGEKSEKUSI LP FIBONACCI...`);
    
    // --- FINAL BALANCE CHECK ---
    const balances = await getWalletBalances();
    const safetyMargin = 0.01;
    const totalRequired = amountSol + safetyMargin;
    
    if (balances.sol < totalRequired) {
        console.log(`❌ GAGAL: Saldo SOL tidak cukup. Saldo: ${balances.sol.toFixed(4)} | Dibutuhkan: ${totalRequired.toFixed(4)} SOL`);
        await notifyError(`⚠️ *EXECUTION ABORTED*\nSaldo tidak cukup untuk membuka posisi ${pool.name}.\nSaldo: ${balances.sol.toFixed(4)} | Butuh: ${totalRequired.toFixed(4)} SOL`);
        return;
    }

    const binStep = Number(pool.bin_step || pool.binStep || 100);
    
    // 1. Tentukan Target Range (Memprioritaskan Fibo Bottom)
    // Kita gunakan bottomPrice Fibo sebagai target utama jaring.
    // Kita hanya menyesuaikan jika harganya sudah jebol atau range-nya terlalu sempit.
    
    let targetPrice = bottomPrice;
    const minSafetyDrop = 0.15; // Minimal jaring 15% drop
    const maxSafetyDrop = 0.85; // Maksimal jaring 85% drop
    
    const currentDrop = (currentPrice - targetPrice) / currentPrice;

    if (targetPrice >= currentPrice) {
        // KASUS: Harga saat ini sudah di bawah Fibo Bottom.
        // Kita gunakan ATL asli sebagai target bawah, atau minimal 20% drop dari harga sekarang agar jaring tidak kosong.
        console.log(`💡 Note: Harga saat ini sudah di bawah Fibo Bottom (${bottomPrice.toFixed(10)}).`);
        targetPrice = Math.min(bottomPrice, currentPrice * 0.80);
        console.log(`🎯 Menyesuaikan jaring akumulasi ke: ${targetPrice.toFixed(10)} SOL`);
    } 
    else if (currentDrop < minSafetyDrop) {
        // Kasus: Jarak ke Bottom Fibo terlalu sempit. Kita lebarkan sedikit agar ada ruang akumulasi.
        console.log(`💡 Note: Range Fibo ke Bottom terlalu sempit (${(currentDrop*100).toFixed(2)}%). Memperlebar jaring ke 20% drop.`);
        targetPrice = currentPrice * 0.80;
    }
    else if (currentDrop > maxSafetyDrop) {
        // Kasus: Jarak ke Bottom Fibo terlalu jauh (> 85%). Kita batasi agar tidak error rent.
        console.log(`💡 Note: Range Fibo ke Bottom terlalu jauh. Membatasi ke 85% drop untuk stabilitas.`);
        targetPrice = currentPrice * 0.15;
    }

    const priceRatio = currentPrice / targetPrice;
    const binsNeeded = Math.abs(Math.round(Math.log(priceRatio) / (binStep * Math.log(1.0001))));
    
    // Batasi jumlah bin: minimal 20 bin, maksimal 450 bin.
    let finalBins = Math.max(20, Math.min(450, binsNeeded));

    // 2. Tentukan Strategi Berdasarkan Lebar Jaring
    const rangePct = Math.abs((currentPrice - targetPrice) / currentPrice * 100);
    let deployments = [];
    
    if (rangePct < 20) {
        // Range Sempit (<20%): Full Spot
        deployments.push({ strategy: "spot", pct: 1.0, label: "SPOT (Narrow Range)" });
    }
    else if (rangePct >= 20 && rangePct < 30) {
        // Range Menengah (20% - 30%): Hybrid 70% BA / 30% Spot
        deployments.push({ strategy: "bid_ask", pct: 0.7, label: "BID_ASK (Hybrid 70%)" });
        deployments.push({ strategy: "spot", pct: 0.3, label: "SPOT (Hybrid 30%)" });
    }
    else {
        // Range Lebar (>=30%): Full Bid-Ask
        deployments.push({ strategy: "bid_ask", pct: 1.0, label: "BID_ASK (Wide Accumulation)" });
    }

    console.log(`-----------------------------------------------`);
    console.log(`📊 ANALISIS LP:`);
    console.log(`- Entry Point: ${currentPrice.toFixed(10)} SOL`);
    console.log(`- Bottom Target: ${targetPrice.toFixed(10)} SOL`);
    console.log(`- Lebar Jaring: ${rangePct.toFixed(2)}% (${finalBins} bins)`);
    console.log(`- Bin Step: ${binStep} | AS Mode: ${autoSwap ? 'ON' : 'OFF'}`);
    console.log(`-----------------------------------------------`);

    let parentPositionAddress = null;

    for (const d of deployments) {
        const deployAmount = amountSol * d.pct;
        console.log(`🚀 Deploying ${d.label}: ${deployAmount.toFixed(4)} SOL...`);
        
        try {
            const deployParams = {
                pool_address: pool.pool,
                amount_sol: deployAmount,
                strategy: d.strategy,
                bins_below: finalBins,
                bins_above: 0,
                volatility: 100
            };

            // Jika ini adalah deployment kedua dalam satu operasi (Hybrid), tambahkan ke posisi yang sama
            if (parentPositionAddress) {
                deployParams.position_address = parentPositionAddress;
                console.log(`🔗 Menambahkan likuiditas ke posisi utama: ${parentPositionAddress}`);
            }

            const res = await deployPosition(deployParams);

            if (res.success || res.dry_run) {
                if (res.dry_run) {
                    console.log(`⚠️  DRY RUN BERHASIL untuk ${d.label}`);
                } else {
                    console.log(`✅ BERHASIL! ${parentPositionAddress ? 'Likuiditas ditambahkan ke' : 'Posisi dibuka'}: ${res.position}`);
                    
                    if (!parentPositionAddress) {
                        parentPositionAddress = res.position; // Simpan untuk deployment berikutnya (Spot)
                        trackPosition(res.position, { 
                            pool: pool.pool, 
                            pair: pool.name, 
                            autoSwap,
                            autoReentry,
                            tpMode: "static", // Default TP 6%
                            baseMint: baseMint || pool.token_x,
                            amountSol: amountSol // Track TOTAL amount since it's one position
                        });
                        notifyDeploy({ pair: `${pool.name} (Hybrid Init: ${d.strategy})`, amountSol: deployAmount, position: res.position });
                    } else {
                        // Notifikasi untuk penambahan likuiditas
                        notifyDeploy({ pair: `${pool.name} (Hybrid Add: ${d.strategy})`, amountSol: deployAmount, position: res.position });
                    }
                }
            } else {
                console.log(`❌ GAGAL Deploy ${d.label}: ${res.error}`);
                
                // Retry Mechanism jika kena error Rent/Missing Bin Array atau Invalid Bin Array (0x178b)
                const isBinError = res.error?.includes("missing bin-array") || 
                                 res.error?.includes("0x178b") || 
                                 res.error?.includes("Invalid bin array");

                if (isBinError) {
                    console.log("🔄 Mencoba menyesuaikan range (shrink) agar pas dengan bin-array yang valid...");
                    const retryBins = Math.max(10, finalBins - 64); // Kurangi 1 array (64 bin)
                    const retryRes = await deployPosition({
                        pool_address: pool.pool,
                        amount_sol: deployAmount,
                        strategy: d.strategy,
                        bins_below: retryBins,
                        bins_above: 0,
                        volatility: 100
                    });

                    if (retryRes.success) {
                        console.log(`✅ Retry Berhasil dengan ${retryBins} bin! Posisi: ${retryRes.position}`);
                        trackPosition(retryRes.position, { 
                            pool: pool.pool, 
                            pair: pool.name, 
                            autoSwap,
                            autoReentry,
                            tpMode: "static",
                            baseMint: baseMint || pool.token_x,
                            amountSol: deployAmount
                        });
                        notifyDeploy({ pair: `${pool.name} (${d.strategy} - Adjusted)`, amountSol: deployAmount, position: retryRes.position });
                    } else {
                        console.log(`❌ Retry tetap gagal: ${retryRes.error}`);
                    }
                }
            }
        } catch (e) {
            console.log(`❌ CRITICAL ERROR during deploy: ${e.message}`);
        }
        
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
                readline.clearLine(process.stdout, 0);
                readline.cursorTo(process.stdout, 0);
                process.stdout.write(`[Monitor ${pool.name}] Harga: ${currentPrice.toFixed(10)} | Target: < ${currentEntry.toFixed(10)}`);

                if (currentPrice <= currentEntry) {
                    console.log(`\n\n🎯 ENTRY POINT TERCAPAI!`);
                    isDeployed = true;

                    if (!autoReentry) {
                        clearInterval(interval);
                        pendingOrders.delete(ca);
                    }

                    await executeFibDeploy(pool, amountSol, currentPrice, currentBottom, autoSwap, baseMint, bottomLevel, autoReentry, currentEntry);
                    process.stdout.write("\nDeltLP> ");
                }
            }
 else if (autoReentry) {
                readline.clearLine(process.stdout, 0);
                readline.cursorTo(process.stdout, 0);
                process.stdout.write(`[AR Monitor ${pool.name}] Harga: ${currentPrice.toFixed(10)} | ATH saat ini: ${currentAth.toFixed(10)}`);
            }

        } catch (e) { }
    }, 15000);
    
    pendingOrders.set(ca, { 
        interval, 
        poolName: pool.name, 
        amountSol, 
        entryPrice, 
        autoSwap, 
        autoReentry,
        isDeployed: isAlreadyDeployed 
    });
}

/**
 * Fungsi Deploy Manual via CA dengan Strategi Fibonacci & Optimasi Pool
 */
async function manualDeploy(ca, amountSol, manualAth = null, manualAtl = null, autoSwap = false, autoReentry = false) {
  try {
    console.log(`\n🔎 MENGGUNAKAN STRATEGI FIBONACCI (AS Mode: ${autoSwap}, AR Mode: ${autoReentry})`);
    
    // --- BALANCE CHECK ---
    const balances = await getWalletBalances();
    const safetyMargin = 0.01; // Cadangan minimal untuk gas fee & rent
    const totalRequired = amountSol + safetyMargin;
    
    if (balances.sol < totalRequired) {
        console.log(`❌ GAGAL: Saldo SOL tidak cukup. Saldo: ${balances.sol.toFixed(4)} | Dibutuhkan: ${totalRequired.toFixed(4)} SOL`);
        await notifyError(`⚠️ *EXECUTION ABORTED*\nSaldo tidak cukup untuk membuka posisi koin ${ca.slice(0,8)}.\nSaldo: ${balances.sol.toFixed(4)} | Butuh: ${totalRequired.toFixed(4)} SOL`);
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

    let ath, atl, supply, athMcapUsd;
    if (manualAth && manualAtl) {
        ath = parseFloat(manualAth);
        atl = parseFloat(manualAtl);
        supply = 0; 
        athMcapUsd = 0;
    } else {
        const anchors = await getAbsoluteAnchors(ca, solPools[0].pool);
        ath = anchors.ath;
        atl = anchors.atl;
        supply = anchors.supply;
        athMcapUsd = anchors.athMcapUsd;
    }
    
    // DECISION: Pilih Bottom Level berdasarkan ATH Market Cap USD
    // Jika ATH MCap >= $650k -> Big Coin (0.786)
    // Jika ATH MCap < $650k atau tidak diketahui -> Degen Coin (0.887)
    const isBigCoin = athMcapUsd >= 650000;
    const bottomLevel = isBigCoin ? 0.786 : 0.887;
    
    console.log(`🎯 STRATEGY DECISION:`);
    console.log(`- ATH MCap: $${Math.round(athMcapUsd).toLocaleString()}`);
    console.log(`- Type: ${isBigCoin ? 'BIG COIN (Confirmed >$650k)' : 'DEGEN/UNKNOWN (<$650k)'}`);
    console.log(`- Fibo Bottom: ${bottomLevel}`);

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
    const [detailJson, activeBin] = await Promise.all([
        fetchWithLog(`https://dlmm.datapi.meteora.ag/pools/${bestPool.pool}`, "Meteora Detail"),
        getActiveBin({ pool_address: bestPool.pool }).catch(() => ({ price: 0 }))
    ]);

    const officialBinStep = Number(detailJson.pool_config?.bin_step || detailJson.bin_step || bestPool.bin_step);
    const currentPrice = Number(activeBin.price) || Number(detailJson.current_price || 0);
    const baseMint = detailJson.token_x?.address || detailJson.tokenX || bestPool.token_x;

    bestPool.bin_step = officialBinStep;

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
        await executeFibDeploy(bestPool, amountSol, currentPrice, bottomPrice, autoSwap, baseMint, bottomLevel, autoReentry, entryPrice);
        
        if (!autoReentry) {
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
      case "lo":
      case "/lo": {
        const loCa = parts[1];
        let loAmt = 0.001;
        let loMode = "BA";
        
        for (let i = 2; i < parts.length; i++) {
            const p = parts[i].toUpperCase();
            if (p === "SPOT") loMode = "SPOT";
            else if (p === "BA") loMode = "BA";
            else {
                const val = parseFloat(p);
                if (!isNaN(val)) loAmt = val;
            }
        }

        if (!loCa) console.log("Usage: lo <CA> [amount] [BA/Spot]");
        else await executeLimitOrder(loCa, loAmt, loMode);
        break;
      }

      case "lp":
      case "/lp":
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

        if (!ca) console.log("Usage: lp <CA> [amount] [AS] [AR]");
        else await manualDeploy(ca, amt, null, null, isAS, isAR);
        break;

      case "status":
      case "/status":
        const balances = await getWalletBalances();
        console.log(`\n💰 Balance: ${balances.sol.toFixed(4)} SOL`);

        // 1. Pending Orders
        if (pendingOrders.size > 0) {
            console.log(`⏳ Pending Orders (${pendingOrders.size}):`);
            for (const [ca, order] of pendingOrders.entries()) {
                if (!order.isDeployed) {
                    console.log(`- ${order.poolName}: Target < ${order.entryPrice.toFixed(10)} SOL | Amt: ${order.amountSol} SOL`);
                }
            }
        }

        // 2. Active Positions
        const posData = await getMyPositions({ force: true });
        console.log(`📊 Active Positions: ${posData.total_positions}`);
        const unit = config.management.solMode ? "SOL" : "USD";
        posData.positions?.forEach((p, i) => {
          const tracked = getTrackedPosition(p.position);
          const tpMode = (tracked?.tpMode || "static").toUpperCase();
          const arStatus = tracked?.autoReentry ? 'ON' : 'OFF';
          const pnlVal = p.pnl_usd || 0;
          console.log(`${i+1}. ${p.pair} | Range: ${p.in_range ? 'IN' : 'OOR'} | Age: ${p.age_minutes}m | PnL: ${pnlVal.toFixed(4)} ${unit} (${p.pnl_pct?.toFixed(2) || 0}%) | AS: ${tracked?.autoSwap ? 'ON' : 'OFF'} | AR: ${arStatus} | TP: ${tpMode}`);
        });
        break;

      case "tp":
      case "/tp": {
        const subCmd = parts[1]?.toLowerCase(); // 'tr', 'bb', 'on', 'off'
        const tpIdx = parseInt(parts[2]) - 1;
        const tpPos = await getMyPositions({ force: true });
        const tpTarget = tpPos.positions?.[tpIdx];
        
        if (!tpTarget) {
            console.log("Usage: tp <tr/bb/off> <index_number>");
            break;
        }

        if (subCmd === "tr") {
            updateTrackedPosition(tpTarget.position, { tpMode: "trailing", lockedPnl: 0 });
            console.log(`✅ TP Trailing AKTIF untuk ${tpTarget.pair}. (Lock PnL-3% mulai dari 8%)`);
        } else if (subCmd === "bb") {
            updateTrackedPosition(tpTarget.position, { tpMode: "bollinger" });
            console.log(`✅ TP Bollinger AKTIF untuk ${tpTarget.pair}. (Min 5% + Hit BB Upper 15m)`);
        } else if (subCmd === "off") {
            updateTrackedPosition(tpTarget.position, { tpMode: "disabled" });
            console.log(`✅ TP DINONAKTIFKAN untuk ${tpTarget.pair}.`);
        } else {
            console.log("Usage: tp <tr/bb/off> <index_number>");
        }
        break;
      }

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
        console.log("  lp <CA> [amount] [AS] [AR] - Buka LP Fibonacci (AS: Auto-Swap, AR: Auto-Reentry)");
        console.log("  lo <CA> [amount] [BA/Spot] - Buka Limit Order Fibonacci");
        console.log("  status                      - Cek saldo dan posisi");
        console.log("  set <tp/sl> <value>         - Atur global TP/SL (%)");
        console.log("  config                      - Lihat pengaturan saat ini");
        console.log("  close <no>                  - Tutup posisi");
        console.log("  as <no>                     - Aktifkan Auto-Swap (AS) per posisi");
        console.log("  tp <tr/bb/off> <no>         - Atur Mode TP (tr: Trailing, bb: Bollinger, off: Mati)");
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
        
        let msg = `💰 *Balance:* ${balances.sol.toFixed(4)} SOL\n\n`;

        // 1. Pending Orders
        if (pendingOrders.size > 0) {
            msg += `⏳ *Pending Orders (${pendingOrders.size}):*\n`;
            for (const [ca, order] of pendingOrders.entries()) {
                if (!order.isDeployed) {
                    msg += `- ${order.poolName}: Target < ${order.entryPrice.toFixed(10)} SOL | Amt: ${order.amountSol} SOL\n`;
                }
            }
            msg += `\n`;
        }

        // 2. Active Positions
        msg += `📊 *Active Positions (${posData.total_positions}):*\n`;
        posData.positions?.forEach((p, i) => {
            const tr = getTrackedPosition(p.position);
            const tpMode = (tr?.tpMode || "static").toUpperCase();
            const arStat = tr?.autoReentry ? '✅ ON' : '❌ OFF';
            const isLO = tr?.isLimitOrder ? ' (LO)' : '';
            const pnlVal = p.pnl_usd || 0;
            msg += `${i+1}. ${p.pair}${isLO} | ${p.in_range ? '✅ IN' : '⚠️ OOR'} | ${pnlVal.toFixed(4)} ${unit} (${p.pnl_pct?.toFixed(2)}%) | AS: ${tr?.autoSwap ? 'ON' : 'OFF'} | AR: ${arStat} | TP: ${tpMode}\n`;
        });
        
        return msg;
    },
    lo: async (ca, amtAndMode) => {
        const parts = String(amtAndMode).split(" ");
        let amt = 0.001;
        let mode = "BA";
        
        for (const part of parts) {
            const p = part.toUpperCase();
            if (p === "SPOT") mode = "SPOT";
            else if (p === "BA") mode = "BA";
            else if (part.trim() !== "") {
                const parsed = parseFloat(part.replace(",", "."));
                if (!isNaN(parsed)) amt = parsed;
            }
        }

        await executeLimitOrder(ca, amt, mode);
    },
    lp: async (ca, amtStr) => {
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
    tp: async (subCmd, idx) => {
        const index = parseInt(idx) - 1;
        const allPos = await getMyPositions({ force: true });
        const target = allPos.positions?.[index];
        const mode = subCmd?.toLowerCase();
        
        if (!target) return "❌ Index position tidak ditemukan.";

        if (mode === "tr") {
            updateTrackedPosition(target.position, { tpMode: "trailing", lockedPnl: 0 });
            return `✅ TP Trailing AKTIF untuk ${target.pair}. (Lock PnL-3% mulai 8%)`;
        } else if (mode === "bb") {
            updateTrackedPosition(target.position, { tpMode: "bollinger" });
            return `✅ TP Bollinger AKTIF untuk ${target.pair}. (Min 5% + Hit BB Upper 15m)`;
        } else if (mode === "off") {
            updateTrackedPosition(target.position, { tpMode: "disabled" });
            return `✅ TP DINONAKTIFKAN untuk ${target.pair}.`;
        }
        return "Usage: /tp <tr/bb/off> <index>";
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
