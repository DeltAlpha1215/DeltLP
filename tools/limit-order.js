import { log } from "../logger.js";
import { deployPosition, getActiveBin } from "./dlmm.js";
import { fetchTokenInfo_GMGN, fetchTokenHistory_GMGN } from "./gmgn.js";
import { getWalletBalances } from "./wallet.js";
import { trackPosition } from "../state.js";
import { notifyDeploy } from "../telegram.js";

/**
 * Eksekusi Limit Order berbasis Fibonacci
 * @param {string} ca - Contract Address
 * @param {number} amountSol - Jumlah SOL yang digunakan
 * @param {string} mode - 'BA' (Bid-Ask) atau 'SPOT'
 */
export async function executeLimitOrder(ca, amountSol, mode = "BA") {
    try {
        console.log(`\n🎯 MEMULAI LIMIT ORDER FIBONACCI (Mode: ${mode.toUpperCase()})`);
        console.log(`🔎 CA: ${ca}`);

        // 1. Ambil Data ATH/ATL via GMGN
        const tokenInfo = await fetchTokenInfo_GMGN(ca);
        if (!tokenInfo) throw new Error("Gagal mengambil data token dari GMGN.");

        const tokenHistory = await fetchTokenHistory_GMGN(ca, tokenInfo.sol_per_usd_ratio, "1h");
        if (!tokenHistory) throw new Error("Gagal mengambil history token.");

        const ath = tokenHistory.ath;
        const atl = tokenHistory.atl;
        const range = ath - atl;

        // 2. Tentukan Level Fibonacci
        // Start Range: 0.618 (Sesuai instruksi)
        const startPrice = ath - (range * 0.618);
        
        // Bottom Price: Ikuti logika LP (Degen 0.887, Big Coin 0.786)
        const isBigCoin = (tokenInfo.ath_mcap_usd >= 650000);
        const bottomLevel = isBigCoin ? 0.786 : 0.887;
        const bottomPrice = ath - (range * bottomLevel);

        console.log(`📈 ATH: ${ath.toFixed(10)} | ATL: ${atl.toFixed(10)}`);
        console.log(`🎯 LO Start (0.618): ${startPrice.toFixed(10)}`);
        console.log(`🛡️ LO Bottom (${bottomLevel}): ${bottomPrice.toFixed(10)}`);

        // 3. Ambil Harga Saat Ini & Pool Terdekat
        const searchResult = await import("./dlmm.js").then(m => m.searchPools({ query: ca, limit: 5 }));
        const bestPool = (searchResult.pools || []).find(p => p.name.includes("-SOL") || p.name.includes("SOL-"));
        
        if (!bestPool) throw new Error("Tidak ditemukan pool SOL untuk koin ini.");

        const activeBin = await getActiveBin({ pool_address: bestPool.pool });
        const currentPrice = Number(activeBin.price);

        console.log(`💰 Harga Saat Ini: ${currentPrice.toFixed(10)} SOL`);

        // 4. Kalkulasi Bin Range
        // Pastikan LO dimulai di bawah harga saat ini
        let effectiveStart = Math.min(currentPrice * 0.99, startPrice);
        let effectiveBottom = Math.min(effectiveStart * 0.90, bottomPrice);

        const binStep = Number(bestPool.bin_step || 100);
        const priceRatio = currentPrice / effectiveBottom;
        const binsNeeded = Math.abs(Math.round(Math.log(priceRatio) / (binStep * Math.log(1.0001))));
        const finalBins = Math.max(10, Math.min(450, binsNeeded));

        const strategy = mode.toUpperCase() === "SPOT" ? "spot" : "bid_ask";

        console.log(`📊 ANALISIS LO:`);
        console.log(`- Target Range: ${effectiveStart.toFixed(10)} ke ${effectiveBottom.toFixed(10)}`);
        console.log(`- Strategy: ${strategy.toUpperCase()} | Bins Below: ${finalBins}`);

        // 5. Eksekusi Deploy sebagai Limit Order (Likuiditas satu sisi)
        // Meteora DLMM: bins_below dari currentPrice akan menaruh SOL (token Y)
        const res = await deployPosition({
            pool_address: bestPool.pool,
            amount_sol: amountSol,
            strategy: strategy,
            bins_below: finalBins,
            bins_above: 0,
            volatility: 100
        });

        if (res.success) {
            console.log(`✅ LO BERHASIL! Posisi: ${res.position}`);
            trackPosition(res.position, {
                pool: bestPool.pool,
                pair: bestPool.name,
                tpMode: "trailing",
                stopLossPct: -30,
                trailingActivationPct: 30,
                amountSol: amountSol,
                isLimitOrder: true,
                loRange: { start: effectiveStart, bottom: effectiveBottom }
            });
            notifyDeploy({ pair: `${bestPool.name} (LO ${mode})`, amountSol, position: res.position });
        } else {
            console.log(`❌ LO GAGAL: ${res.error}`);
        }

    } catch (err) {
        log("error", `Limit Order Error: ${err.message}`);
        console.log(`❌ ERROR: ${err.message}`);
    }
}
