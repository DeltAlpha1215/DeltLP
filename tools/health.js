import { fetchTokenHistory_GMGN, fetchTokenInfo_GMGN } from "./gmgn.js";
import { log } from "../logger.js";

/**
 * Perform a Health Check on a token to detect "Slow Rug" or "Death Spiral" patterns.
 * @param {string} ca - Token Mint Address
 * @returns {Object} Health report
 */
export async function checkTokenHealth(ca) {
    try {
        // 1. Fetch Data
        const tokenInfo = await fetchTokenInfo_GMGN(ca);
        if (!tokenInfo) return { score: 0, status: "Unknown", reasons: ["Failed to fetch token info"] };

        // Fetch 1m/5m history for detailed retrace check
        const history = await fetchTokenHistory_GMGN(ca, tokenInfo.sol_per_usd_ratio, "5m");
        if (!history || !history.list || history.list.length < 8) {
            return { score: 100, status: "Establishing", reasons: ["Waiting for more market data (min 8 candles)"] };
        }

        const klines = history.list.slice(-12); 
        const latestPrice = klines[klines.length - 1].close;
        const hourHigh = Math.max(...klines.map(k => k.high));
        const hourLow = Math.min(...klines.map(k => k.low));

        let score = 100;
        let reasons = [];

        // --- 1. NO RETRACE DETECTION (Dynamic based on drop size) ---
        const dropMagnitude = (hourHigh - hourLow) / hourHigh;
        const retraceLevel = hourLow + ((hourHigh - hourLow) * 0.382); 
        
        // Only penalize if the drop is significant (> 5%)
        if (dropMagnitude > 0.05) {
            const maxRecentClose = Math.max(...klines.slice(-4).map(k => k.close)); 
            if (latestPrice < hourHigh && maxRecentClose < retraceLevel) {
                score -= 25; 
                reasons.push("NO_RETRACE: Steady decline without 38.2% bounce");
            }
        }

        // --- 2. VOLUME-PRICE DIVERGENCE (VPD) ---
        const avgVol = klines.reduce((acc, k) => acc + Number(k.volume || 0), 0) / klines.length;
        const recentVol = klines.slice(-3).reduce((acc, k) => acc + Number(k.volume || 0), 0) / 3;
        const priceChange = ((latestPrice - klines[klines.length - 3].open) / klines[klines.length - 3].open) * 100;

        if (recentVol > (avgVol * 2.0) && priceChange < -3) { 
            score -= 30;
            reasons.push("VPD: High sell volume with sharp decline");
        }

        // --- 3. TREND CONSISTENCY (THE "BLEED") ---
        const redCandles = klines.filter(k => k.close < k.open).length;
        if (redCandles >= 11) {
            score -= 40; 
            reasons.push(`BLEEDING: Extreme Bearish Streak (${redCandles}/12 RED)`);
        } else if (redCandles >= 10) {
            score -= 20;
            reasons.push(`BEARISH_STREAK: ${redCandles}/12 candles are RED`);
        }

        // --- 4. CONSECUTIVE REDS (Last 5 candles) ---
        let consecutiveRed = 0;
        for (let i = klines.length - 1; i >= Math.max(0, klines.length - 5); i--) {
            if (klines[i].close < klines[i].open) consecutiveRed++;
            else break;
        }
        if (consecutiveRed >= 5) {
            score -= 15;
            reasons.push(`STREAK: ${consecutiveRed} consecutive RED candles`);
        }

        let status = "Healthy";
        if (score <= 40) status = "CRITICAL (Possible Slow Rug)";
        else if (score <= 70) status = "Warning";

        return {
            score,
            status,
            reasons,
            metrics: {
                retraceLevel,
                latestPrice,
                volRatio: (recentVol / avgVol).toFixed(2),
                redCandles
            }
        };

    } catch (e) {
        log("error", `Health Check Failed: ${e.message}`);
        return { score: 0, status: "Error", reasons: [e.message] };
    }
}
