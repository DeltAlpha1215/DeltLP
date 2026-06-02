import "dotenv/config";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE = `https://api.telegram.org/bot${TOKEN}`;

async function test() {
    try {
        const res = await fetch(`${BASE}/getMe`);
        const json = await res.json();
        console.log(JSON.stringify(json, null, 2));
    } catch (e) {
        console.error("Test failed:", e.message);
    }
}

test();
