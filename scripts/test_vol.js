import { getPoolVolatility } from "../tools/meteora-top.js";

async function test() {
    const cas = [
        "25e7VnBMhK9b6z37PSx81qbxBMYSUXqiRvBodxy3qEVE", // A pool address (test if it works with pool addr)
        "2kBH6UcR8vW2N3y5KkX9pZ6Y3vG1J1D4mK8P5pY6pump", // Random token
        "9VY2rDbtsBmTsBxoRF8hWSEUKGqnoQoe9V6W3JnjNgfm"  // Another token from state
    ];

    for (const ca of cas) {
        const res = await fetch(`https://pool-discovery-api.datapi.meteora.ag/pools?search_term=${ca}&limit=10`);
        const json = await res.json();
        console.log(`Found ${json.data?.length} pools:`);
        json.data?.forEach(p => console.log(`- ${p.name} (${p.pool_address}) [${p.token_x?.address} / ${p.token_y?.address}]`));
        
        const info = await getPoolVolatility(ca);
        if (info) {
            console.log(`Pool: ${info.name} | Vol: ${info.volatility}`);
        } else {
            console.log("No info found.");
        }
    }
}

test();
