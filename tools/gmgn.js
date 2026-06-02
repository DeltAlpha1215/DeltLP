import "dotenv/config";
import { log } from "../logger.js";
import { execSync } from "child_process";

/**
 * Run gmgn-cli command and return parsed JSON
 */
function runGMGNCli(command) {
    const apiKey = process.env.GMGN_API_KEY;
    if (!apiKey) throw new Error("GMGN_API_KEY is not configured.");

    try {
        const fullCommand = `GMGN_API_KEY=${apiKey} npx gmgn-cli ${command} --raw`;
        const output = execSync(fullCommand, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return JSON.parse(output);
    } catch (e) {
        log("error", `GMGN CLI Command Failed: ${command} - ${e.message}`);
        return null;
    }
}

/**
 * Fetch token info from GMGN.ai
 */
export async function fetchTokenInfo_GMGN(ca) {
    try {
        const data = runGMGNCli(`token info --chain sol --address ${ca}`);
        if (!data) return null;

        // Cari harga SOL dari pool reserves (paling akurat untuk rasio)
        let priceSol = Number(data.price?.price_sol || 0);
        const quoteSymbol = data.pool?.quote_symbol?.toUpperCase() || "SOL";
        const isUsdPool = quoteSymbol === "USDC" || quoteSymbol === "USDT" || quoteSymbol === "USD";

        if (isUsdPool || !priceSol) {
            const quoteRes = Number(data.pool?.quote_reserve || 0);
            const baseRes = Number(data.pool?.base_reserve || 0);
            if (quoteRes > 0 && baseRes > 0) {
                const rawPrice = quoteRes / baseRes;
                if (isUsdPool) {
                    // Jika pool USDC, rawPrice adalah USD. Konversi ke SOL.
                    const solPriceUsd = await getSolPriceUsd_Internal();
                    priceSol = rawPrice / solPriceUsd;
                } else {
                    priceSol = rawPrice;
                }
            }
        }

        // Jika masih nol, coba cari dari metadata price
        if (!priceSol && data.price?.price) {
            const solPriceUsd = await getSolPriceUsd_Internal();
            priceSol = Number(data.price.price) / solPriceUsd;
        }

        const priceUsd = Number(data.price?.price || (priceSol * 150));
        const supply = Number(data.circulating_supply || data.total_supply || 0);
        const athPriceUsd = Number(data.ath_price || 0);

        // Hitung Rasio SOL/USD koin ini untuk konversi history nanti
        const solPerUsd = (priceSol > 0 && priceUsd > 0) ? (priceSol / priceUsd) : (1 / 150);

        // Ambil ATH Market Cap (USD) LANGSUNG dari data koin ini (Hapus dev.ath_token_info.ath_mc karena itu koin lain si dev)
        let athMcapUsd = Number(data.ath_market_cap || data.ath_mc || 0);
        
        // Jika field ATH MCap kosong, hitung sendiri dari ATH Price koin ini * Supply
        if (!athMcapUsd && athPriceUsd > 0 && supply > 0) {
            athMcapUsd = athPriceUsd * supply;
        }

        // Hitung ATH dalam SOL
        const athPriceSol = (athPriceUsd > 0 && priceUsd > 0) 
            ? (athPriceUsd / priceUsd) * priceSol 
            : (athPriceUsd * solPerUsd);

        return {
            name: data.symbol || data.name,
            symbol: data.symbol,
            supply: supply,
            price_sol: priceSol,
            ath_sol: athPriceSol,
            sol_per_usd_ratio: solPerUsd, 
            ath_mcap_usd: athMcapUsd, 
            mcap_usd: Number(data.market_cap || (priceUsd * supply))
        };

    } catch (e) {
        log("error", `GMGN Token Info Fetch Failed: ${e.message}`);
        return null;
    }
}

/**
 * Internal helper to get SOL price for conversion
 */
async function getSolPriceUsd_Internal() {
    try {
        const res = await fetch("https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112");
        const json = await res.json();
        const price = parseFloat(json["So11111111111111111111111111111111111111112"]?.usdPrice);
        if (!isNaN(price) && price > 0) return price;
    } catch { }
    return 150; // Fallback
}

/**
 * Fetch OHLCV history from GMGN.ai (Synced to SOL)
 */
export async function fetchTokenHistory_GMGN(ca, solPerUsdRatio = null, resolution = "1d") {
    try {
        const data = runGMGNCli(`market kline --chain sol --address ${ca} --resolution ${resolution}`);
        const list = data?.list || [];
        if (list.length === 0) return null;

        // Gunakan rasio untuk konversi harga riwayat (USD) ke SOL
        const ratio = solPerUsdRatio || (1 / 150);
        
        const prices = list.map(h => Number(h.high) * ratio);
        const lows = list.map(h => Number(h.low) * ratio);

        return {
            ath: Math.max(...prices),
            atl: Math.min(...lows),
            list: list.map(h => ({
                ...h,
                high: Number(h.high) * ratio,
                low: Number(h.low) * ratio,
                open: Number(h.open) * ratio,
                close: Number(h.close) * ratio
            }))
        };
    } catch (e) {
        log("error", `GMGN Token History Fetch Failed: ${e.message}`);
        return null;
    }
}

/**
 * TECHNICAL ANALYSIS HELPERS
 */

function calculateSMA(values, period) {
    if (values.length < period) return null;
    let sum = 0;
    for (let i = values.length - period; i < values.length; i++) {
        sum += values[i];
    }
    return sum / period;
}

function calculateStandardDeviation(values, period, sma) {
    if (values.length < period || sma == null) return null;
    let sumSquares = 0;
    for (let i = values.length - period; i < values.length; i++) {
        sumSquares += Math.pow(values[i] - sma, 2);
    }
    return Math.sqrt(sumSquares / period);
}

/**
 * Calculate RSI for the latest candle
 */
export function calculateRSI(klines, period = 14) {
    if (!klines || klines.length < period + 1) return null;

    const closes = klines.map(k => Number(k.close));
    let gains = 0;
    let losses = 0;

    for (let i = klines.length - period; i < klines.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }

    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
}

/**
 * Calculate Bollinger Bands for the latest candle
 */
export function calculateBollingerBands(klines, period = 20, multiplier = 2) {
    if (!klines || klines.length < period) return null;
    
    const closes = klines.map(k => Number(k.close));
    const sma = calculateSMA(closes, period);
    const stdDev = calculateStandardDeviation(closes, period, sma);
    
    if (sma == null || stdDev == null) return null;

    return {
        middle: sma,
        upper: sma + (multiplier * stdDev),
        lower: sma - (multiplier * stdDev)
    };
}
