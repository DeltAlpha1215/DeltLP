import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "..", "state.json");

function cleanup() {
    if (!fs.existsSync(STATE_FILE)) return;
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    
    // 1. Remove [object Object]
    if (state["[object Object]"]) {
        console.log("Removing corrupted [object Object] entry...");
        delete state["[object Object]"];
    }

    // 2. Fix baseMint objects
    for (const key in state) {
        if (state[key].baseMint && typeof state[key].baseMint === 'object') {
            console.log(`Fixing baseMint for ${key}...`);
            state[key].baseMint = state[key].baseMint.mint || state[key].baseMint.address;
        }
    }

    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log("Cleanup complete.");
}

cleanup();
