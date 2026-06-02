import "dotenv/config";
import { getTrackedPositions } from "../state.js";
import { getPositionPnl } from "../tools/dlmm.js";

async function checkPnL() {
    const state = getTrackedPositions();
    console.log("Current Tracked Positions:");
    for (const addr in state) {
        const pos = state[addr];
        if (pos.pair) {
            console.log(`\nAddress: ${addr}`);
            console.log(`Pair: ${pos.pair}`);
            try {
                const pnl = await getPositionPnl(addr);
                console.log(`PnL: ${pnl.pnl_pct.toFixed(2)}% (${pnl.pnl_usd.toFixed(4)} USD)`);
                console.log(`Value: ${pnl.current_value_usd.toFixed(4)} USD`);
            } catch (err) {
                console.log(`Failed to fetch PnL: ${err.message}`);
            }
        }
    }
}

checkPnL();
