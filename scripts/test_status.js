import "dotenv/config";
import { getMyPositions } from "../tools/dlmm.js";
import { getWalletBalances } from "../tools/wallet.js";
import { config } from "../config.js";
import { getTrackedPosition } from "../state.js";
import { checkTokenHealth } from "../tools/health.js";

async function testStatus() {
    try {
        console.log("📊 Generating status report...");
        const balances = await getWalletBalances();
        console.log(`📊 Balances fetched: ${balances.sol.toFixed(4)} SOL`);
        
        const posData = await getMyPositions({ force: true });
        console.log(`📊 Positions fetched: ${posData.total_positions}`);
        
        // --- ADD DUMMY POSITION FOR TESTING ---
        if (posData.positions.length === 0) {
            console.log("Adding dummy position for testing...");
            posData.positions.push({
                position: "dummy_address",
                pool: "dummy_pool",
                pair: "TEST/SOL",
                base_mint: "So11111111111111111111111111111111111111112",
                in_range: true,
                pnl_usd: 1.23,
                pnl_pct: 5.67
            });
            posData.total_positions = 1;
        }
        // --------------------------------------
        
        const unit = config.management.solMode ? "SOL" : "USD";
        let msg = `💰 *Balance:* ${balances.sol.toFixed(4)} SOL\n\n`;

        // 2. Active Positions
        msg += `📊 *Active Positions (${posData.total_positions}):*\n`;
        for (const p of (posData.positions || [])) {
            const tr = getTrackedPosition(p.position);
            const pnlVal = p.pnl_usd || 0;
            const mintAddr = p.base_mint || p.token_x || p.baseMint || p.token_x_address;

            let healthDisp = "[H: --]";
            if (mintAddr && mintAddr !== "So11111111111111111111111111111111111111112") {
                const health = await checkTokenHealth(mintAddr).catch(() => ({ score: undefined }));
                healthDisp = health.score !== undefined ? `[H: ${health.score}]` : "[H: ERR]";
            }

            msg += `${healthDisp} ${p.pair} | ${p.in_range ? '✅ IN' : '⚠️ OOR'} | ${pnlVal.toFixed(4)} ${unit} (${(p.pnl_pct || 0).toFixed(2)}%)\n`;
        }
        
        console.log("\n--- RESULT ---\n");
        console.log(msg);
        console.log("\n--------------\n");
    } catch (err) {
        console.error("❌ Fatal error in status test:", err);
    }
}

testStatus();
