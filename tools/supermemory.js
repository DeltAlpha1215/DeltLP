import "dotenv/config";
import { log } from "../logger.js";

const API_KEY = process.env.SUPERMEMORY_API_KEY;
const API_BASE = "https://api.supermemory.ai";

/**
 * Add a new memory/fact to the knowledge graph
 */
export async function addMemory(content, tags = ["deltlp", "bot-brain"]) {
    if (!API_KEY) return null;

    try {
        const response = await fetch(`${API_BASE}/v3/documents`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                content,
                containerTags: tags
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Supermemory API Error: ${err}`);
        }

        const data = await response.json();
        log("memory", `Fact stored: "${content.slice(0, 50)}..."`);
        return data;
    } catch (e) {
        log("memory_error", `Failed to add memory: ${e.message}`);
        return null;
    }
}

/**
 * Search for relevant memories based on a query
 */
export async function queryMemory(query) {
    if (!API_KEY) return [];

    try {
        const response = await fetch(`${API_BASE}/v4/search`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${API_KEY}`
            },
            body: JSON.stringify({ 
                q: query,
                containerTag: "deltlp-agent"
            })
        });

        if (!response.ok) return [];

        const data = await response.json();
        return data.results || [];
    } catch (e) {
        log("memory_error", `Query failed: ${e.message}`);
        return [];
    }
}
