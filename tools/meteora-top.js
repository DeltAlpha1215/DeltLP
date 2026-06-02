import { log } from "../logger.js";

/**
 * Fetch specific pool info including volatility for a token CA
 */
export async function getPoolVolatility(caOrPool, symbol = null) {
    console.log(`[DEBUG] getPoolVolatility starting for: ${caOrPool}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        console.log(`[DEBUG] getPoolVolatility TIMEOUT reached for: ${caOrPool}`);
        controller.abort();
    }, 10000); 
    
    try {
        console.log(`[DEBUG] Fetching surgical precision data from Meteora Discovery API...`);
        
        // METHOD 1: Precise filter by pool address (Guaranteed accuracy if it's a pool address)
        const surgicalUrl = `https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${caOrPool}`)}`;
        
        const res = await fetch(surgicalUrl, { signal: controller.signal });
        let bestPool = null;

        if (res.ok) {
            const json = await res.json();
            if (json.data && json.data.length > 0) {
                bestPool = json.data[0];
            }
        }

        // METHOD 2: Fallback to deep scan if surgical failed (e.g. if caOrPool is a token CA)
        if (!bestPool) {
            console.log(`[DEBUG] Surgical precision failed, falling back to deep scan...`);
            const searchTerms = [caOrPool];
            if (symbol) searchTerms.push(symbol);
            
            let allPools = [];
            for (const term of searchTerms) {
                const urls = [
                    `https://pool-discovery-api.datapi.meteora.ag/pools?search_term=${term}&limit=100`,
                    `https://pool-discovery-api.datapi.meteora.ag/pools?category=trending&limit=100`
                ];
                for (const url of urls) {
                    try {
                        const searchRes = await fetch(url, { signal: controller.signal });
                        if (searchRes.ok) {
                            const json = await searchRes.json();
                            if (json.data) allPools = allPools.concat(json.data);
                        }
                    } catch (e) { }
                }
            }

            // Matching logic within deep scan
            bestPool = allPools.find(p => p.pool_address === caOrPool);
            if (!bestPool) {
                bestPool = allPools.find(p => 
                    p.pool_type === "dlmm" && 
                    (p.token_x?.address === caOrPool || p.token_y?.address === caOrPool) &&
                    p.name && (p.name.toUpperCase().includes("SOL"))
                );
            }
        }

        clearTimeout(timeout);

        if (!bestPool) {
            console.log(`[DEBUG] No matching pool found for ${caOrPool}`);
            return null;
        }

        const vol = Number(bestPool.volatility || 0);
        console.log(`[DEBUG] Best pool found: ${bestPool.name} (${bestPool.pool_address}) | Vol: ${vol}`);
        
        return {
            name: bestPool.name,
            address: bestPool.pool_address,
            volatility: vol,
            dynamic_fee: Number(bestPool.dynamic_fee_pct || 0),
            mcap: Number(bestPool.token_x?.address === caOrPool ? bestPool.token_x.market_cap : bestPool.token_y?.market_cap || 0)
        };
    } catch (e) {
        clearTimeout(timeout);
        console.log(`[DEBUG] getPoolVolatility ERROR: ${e.message}`);
        return null;
    }
}

/**
 * Fetch top performing DLMM pools using Meteora's specialized Pool Discovery API.
 */
export async function getMeteoraTopPools(limit = 10) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout
    
    try {
        log("info", "Fetching potential pools from Meteora Discovery API (Scan Depth 500)...");
        
        const res = await fetch("https://pool-discovery-api.datapi.meteora.ag/pools?category=trending&limit=500", {
            signal: controller.signal
        });
        clearTimeout(timeout);
        
        if (!res.ok) throw new Error(`Meteora Discovery API Error: ${res.status}`);
        
        const json = await res.json();
        const poolList = json.data || [];
        
        log("info", `Deep-scanning ${poolList.length} pools for Alpha candidates...`);

        const candidates = poolList
            .filter(p => {
                if (p.pool_type !== "dlmm") return false;

                let assetToken = p.token_x?.address === "So11111111111111111111111111111111111111112" ? p.token_y : p.token_x;
                if (!assetToken || !assetToken.address || assetToken.address === "So11111111111111111111111111111111111111112") return false;

                // ─── USER FILTERS ───
                const mcap = Number(assetToken.market_cap || 0);
                if (mcap < 150000 || mcap > 3000000) return false;

                const organicScore = Number(assetToken.organic_score || 0);
                if (organicScore < 60) return false;

                const holders = Number(assetToken.holders || 0);
                if (holders < 80) return false;

                const topHoldersPct = Number(assetToken.top_holders_pct || 100);
                if (topHoldersPct >= 35) return false;

                const yieldPct = Number(p.fee_active_tvl_ratio || 0);
                if (yieldPct < 1.0) return false;

                if (!assetToken.is_verified) return false;

                return true;
            })
            .map(p => {
                let assetToken = p.token_x?.address === "So11111111111111111111111111111111111111112" ? p.token_y : p.token_x;
                return {
                    name: p.name,
                    mint: assetToken.address,
                    mcap: Number(assetToken.market_cap || 0),
                    vol: Number(p.volume || 0),
                    yield: Number(p.fee_active_tvl_ratio || 0),
                    score: Number(assetToken.organic_score || 0),
                    holders: Number(assetToken.holders || 0)
                };
            })
            .sort((a, b) => b.vol - a.vol)
            .slice(0, limit);

        log("info", `Alpha scan complete. Found ${candidates.length} candidates.`);
        return candidates;

    } catch (e) {
        clearTimeout(timeout);
        log("error", `Meteora Alpha Scan Failed: ${e.message}`);
        return [];
    }
}
