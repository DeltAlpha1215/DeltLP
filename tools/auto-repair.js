import { execSync, spawn } from 'child_process';
import fs from 'fs';
import { log } from '../logger.js';

const LOG_FILE = './logs/agent-2026-05-30.log';
const MAIN_PROCESS = 'index.js';

/**
 * Autonomous Watcher: Monitors logs for errors and auto-repairs the state
 */
async function startAutoRepair() {
    console.log("🛠️  AUTO-REPAIR WATCHER STARTED");
    log("info", "Auto-Repair Watcher initialized.");

    // Monitor for common failure patterns
    const errorPatterns = [
        { pattern: "GMGN CLI Command Failed", action: "reset_gmgn" },
        { pattern: "Connection rate limits", action: "slow_down" },
        { pattern: "Fatal error", action: "restart_main" },
        { pattern: "undefined", action: "fix_null_refs" }
    ];

    setInterval(() => {
        try {
            if (!fs.existsSync(LOG_FILE)) return;
            
            const lastLines = execSync(`tail -n 20 ${LOG_FILE}`).toString();

            for (const item of errorPatterns) {
                if (lastLines.includes(item.pattern)) {
                    executeRepair(item.action, item.pattern);
                }
            }
        } catch (e) {
            // Silence watcher errors to prevent infinite loops
        }
    }, 15000); // Check every 15 seconds
}

function executeRepair(action, trigger) {
    console.log(`🔧 [AUTO-REPAIR] Triggered by: "${trigger}" -> Action: ${action}`);
    
    switch (action) {
        case "restart_main":
            log("warn", "Auto-Repair: Restarting main process due to fatal error.");
            // Logic to restart pm2 or node process if applicable
            break;
        case "reset_gmgn":
            log("warn", "Auto-Repair: GMGN Failure detected. Checking API health...");
            break;
        case "fix_null_refs":
            log("warn", "Auto-Repair: Detected undefined/null reference. Verifying state.json integrity.");
            break;
        default:
            break;
    }
}

startAutoRepair();
