import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getPoolVolatility } from "./tools/meteora-top.js";
import { searchPools } from "./tools/dlmm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

// Persistent Admin Chat ID
let currentAdminId = process.env.TELEGRAM_CHAT_ID || null;
let _offset = 0;
let _isPolling = false;

// ─── Persistence ────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) currentAdminId = String(cfg.telegramChatId);
    }
  } catch (e) { }
}

function saveState(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH) ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")) : {};
    cfg.telegramChatId = String(id);
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) { }
}

loadState();

/**
 * authorization check
 */
function isAuthorized(incomingId) {
    const id = String(incomingId);
    
    // 1. Check currentAdminId (from config/state)
    if (currentAdminId && id === currentAdminId) return true;

    // 2. Check all IDs from environment
    const envIds = (process.env.TELEGRAM_CHAT_ID || "").split(",").map(i => i.trim()).filter(Boolean);
    if (envIds.includes(id)) {
        // Migration: If this ID is in env but not yet the currentAdminId in user-config, 
        // we can optionally update it, but returning true is enough for now.
        return true;
    }

    // 3. Fallback: If no admin set, the first one who talks is admin
    if (!currentAdminId && envIds.length === 0) {
        currentAdminId = id;
        saveState(id);
        return true;
    }

    return false;
}

/**
 * Core send function (Direct to one ID)
 */
async function sendToChat(chatId, text, replyMarkup = null) {
    if (!BASE || !chatId) return;
    try {
        const body = {
            chat_id: chatId,
            text: String(text).slice(0, 4096),
            parse_mode: "Markdown"
        };
        if (replyMarkup) body.reply_markup = replyMarkup;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout for sending

        const res = await fetch(`${BASE}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            const errorBody = await res.text();
            log("telegram_error", `SendMessage failed (${res.status}): ${errorBody}`);
            
            // Fallback: try sending without Markdown if it failed
            if (res.status === 400 && errorBody.includes("can't parse entities")) {
                log("info", "Retrying without Markdown parsing...");
                const fallbackBody = {
                    chat_id: chatId,
                    text: String(text).slice(0, 4096)
                };
                if (replyMarkup) fallbackBody.reply_markup = replyMarkup;

                await fetch(`${BASE}/sendMessage`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(fallbackBody)
                });
            }
        }
    } catch (e) { 
        log("telegram_error", `Send failed: ${e.message}`);
    }
}

/**
 * Broadcast to all known admins (Notifications)
 */
async function broadcast(text) {
    const envIds = (process.env.TELEGRAM_CHAT_ID || "").split(",").map(id => id.trim()).filter(Boolean);
    const targets = new Set(envIds);
    if (currentAdminId) targets.add(currentAdminId);
    
    for (const id of targets) {
        await sendToChat(id, text);
    }
}

// ─── Public Notification API ─────────────────────────────────────
export const sendMessage = (txt) => broadcast(txt);
export const notifyError = (txt) => broadcast(`⚠️ *NOTIFICATION*\n${txt}`);

export async function notifyDeploy({ pair, amountSol, position }) {
    await broadcast(`🚀 *LP DEPLOYED*\nPair: ${pair}\nAmount: ${amountSol.toFixed(4)} SOL\nPos: \`${position.slice(0, 8)}...\``);
}

export async function notifyClose({ pair, pnlPct, pnlUsd }) {
    const icon = pnlPct >= 0 ? "🟢" : "🔴";
    await broadcast(`${icon} *LP CLOSED*\nPair: ${pair}\nPnL: ${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)})`);
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
    await broadcast(`🔄 *SWAPPED*\n${inputSymbol} → ${outputSymbol}\nIn: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\nTx: \`${tx?.slice(0, 16)}...\``);
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
    await broadcast(`⚠️ *OUT OF RANGE*\n${pair}\nOOR for ${minutesOOR} minutes`);
}

// ─── Command Listener ──────────────────────────────────────────
const processedUpdates = new Set();

export async function initTelegramBot(handlers = {}) {
  if (!TOKEN || _isPolling) return;
  _isPolling = true;
  log("info", "Telegram Bot Listener started.");

  const poll = async () => {
    try {
      if (process.env.DEBUG_TG) console.log(`[DEBUG_TG] Polling... offset: ${_offset}`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 40000); // 40s timeout (Telegram timeout is 30s)

      const res = await fetch(`${BASE}/getUpdates?offset=${_offset}&timeout=30`, {
          signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
          if (res.status === 401) log("error", "Telegram TOKEN is invalid.");
          return;
      }
      
      const json = await res.json();
      if (!json.ok) {
          log("telegram_error", `API returned ok:false - ${JSON.stringify(json)}`);
          return;
      }
      
      if (json.result.length > 0) {
          log("info", `Received ${json.result.length} updates. Data: ${JSON.stringify(json.result)}`);
      }

      if (!json.result.length) return;

      for (const update of json.result) {
        if (processedUpdates.has(update.update_id)) continue;
        processedUpdates.add(update.update_id);
        if (processedUpdates.size > 1000) {
            const first = processedUpdates.values().next().value;
            processedUpdates.delete(first);
        }
        _offset = update.update_id + 1;

        // Determine Chat ID
        const cid = update.message?.chat.id || update.callback_query?.message.chat.id;
        if (!cid) continue;

        if (!isAuthorized(cid)) {
            const username = update.message?.from?.username || update.callback_query?.from?.username || "unknown";
            log("warn", `Unauthorized access attempt from ID: ${cid} (@${username})`);
            continue;
        }

        // --- 1. Handle Buttons (Callback) ---
        if (update.callback_query) {
            const cb = update.callback_query;
            const data = cb.data;
            log("info", `Telegram Callback: ${data} from ${cb.from.username || cb.from.id}`);

            // Answer callback immediately to remove loading spinner
            try { 
                await fetch(`${BASE}/answerCallbackQuery`, { 
                    method: "POST", 
                    headers: { "Content-Type": "application/json" }, 
                    body: JSON.stringify({ callback_query_id: cb.id }) 
                }); 
            } catch (e) {}

            if (data === "m_o") {
                await sendToChat(cid, "🎯 *Pilih Strategi LP:*\n\n1. *Fibonacci*: Entry 0.236.\n2. *Volatility*: Dinamis (Vol x5/x10).", {
                    inline_keyboard: [[{ text: "📉 Fibonacci", callback_data: "a_f" }, { text: "📊 Volatility", callback_data: "a_v" }], [{ text: "⬅️ Back", callback_data: "m_m" }]]
                });
            } else if (data === "m_s") {
                if (handlers.status) await sendToChat(cid, await handlers.status());
            } else if (data === "m_t") {
                if (handlers.top) {
                    await sendToChat(cid, "🔍 Scanning elite pools...");
                    await sendToChat(cid, await handlers.top());
                }
            } else if (data === "m_c") {
                if (handlers.config) await sendToChat(cid, await handlers.config());
            } else if (data === "m_m") {
                const mm = { inline_keyboard: [[{ text: "🎯 Open Position", callback_data: "m_o" }, { text: "📊 Status", callback_data: "m_s" }], [{ text: "🔥 Top Pools", callback_data: "m_t" }, { text: "⚙️ Config", callback_data: "m_c" }]] };
                await sendToChat(cid, "🤖 *DeltLP Interactive Menu*", mm);
            } else if (data === "a_f") {
                await sendToChat(cid, "📝 Ketik CA koin untuk strategi *Fibonacci*.\nFormat: `/lp <CA> [amount]`");
            } else if (data === "a_v") {
                await sendToChat(cid, "📝 Ketik CA koin untuk strategi *Volatility*.\nFormat: `/lp <CA> [amount]`");
            } 
            // Handle execution commands (colon separated)
            else if (data.includes(":")) {
                const [type, tca, amt, fl, vv] = data.split(":");
                let arg = (fl === "1") ? "AS" : (fl === "2") ? "AR" : (fl === "3") ? "AS AR" : "";
                
                if (type === "f") {
                    await sendToChat(cid, `📉 Memulai LP Fibonacci untuk ${tca.slice(0,8)}...`);
                    if (handlers.lp) await handlers.lp(tca, `${amt} ${arg}`);
                } else if (type === "vt") {
                    await sendToChat(cid, `📊 Memulai LP Tight Vol (x5) untuk ${tca.slice(0,8)}...`);
                    if (handlers.lp_vol) await handlers.lp_vol(tca, `${amt} ${arg} M5 V${vv}`);
                } else if (type === "vw") {
                    await sendToChat(cid, `📊 Memulai LP Wide Vol (x10) untuk ${tca.slice(0,8)}...`);
                    if (handlers.lp_vol) await handlers.lp_vol(tca, `${amt} ${arg} M10 V${vv}`);
                }
            }

            continue;
        }

        // --- 2. Handle Messages ---
        const msg = update.message;
        if (!msg || !msg.text) continue;
        
        const text = msg.text.trim();
        log("info", `Telegram Message from ${cid} (@${msg.from.username || "unknown"}): ${text}`);
        const pts = text.split(" ");
        const cmd = pts[0].toLowerCase();

        if (cmd === "/menu" || cmd === "/start") {
          const mm = { inline_keyboard: [[{ text: "🎯 Open Position", callback_data: "m_o" }, { text: "📊 Status", callback_data: "m_s" }], [{ text: "🔥 Top Pools", callback_data: "m_t" }, { text: "⚙️ Config", callback_data: "m_c" }]] };
          await sendToChat(cid, "🤖 *DeltLP Interactive Menu*", mm);
        } else if (cmd === "/status") {
          if (handlers.status) await sendToChat(cid, await handlers.status());
        } else if (cmd === "/lp") {
          const tca = pts[1];
          const tamt = pts[2] || "0.001";
          const rarg = pts.slice(3).join(" ").toUpperCase();
          if (!tca) { 
              await sendToChat(cid, "Usage: /lp <CA> [amount]"); 
          } else {
              await sendToChat(cid, `🔍 Identifying pool for \`${tca.slice(0,12)}...\``);
              
              let v = 0, pName = "Unknown", pAddr = null;
              try { 
                  // 1. Find pool using reliable Core API
                  const searchRes = await searchPools({ query: tca, limit: 10 });
                  const solPools = (searchRes.pools || []).filter(p => p.name.includes("-SOL") || p.name.includes("SOL-"));
                  
                  if (solPools.length > 0) {
                      const bestPool = solPools[0];
                      pName = bestPool.name;
                      pAddr = bestPool.pool;
                      
                      // 2. Fetch volatility using the specific pool address
                      const pInf = await getPoolVolatility(pAddr); 
                      v = pInf ? pInf.volatility : 0;
                  }
              } catch (err) { 
                  log("telegram_error", `Pool identification failed: ${err.message}`);
              }
              
              const fv = (v > 0 ? v : 2.0).toFixed(1);
              let fl = rarg.includes("AS") && rarg.includes("AR") ? "3" : rarg.includes("AS") ? "1" : rarg.includes("AR") ? "2" : "0";
              
              const markup = { 
                  inline_keyboard: [
                      [{ text: "📉 Fibonacci", callback_data: `f:${tca}:${tamt}:${fl}:${fv}` }], 
                      [{ text: `📊 Tight (x5)`, callback_data: `vt:${tca}:${tamt}:${fl}:${fv}` }, { text: `📊 Wide (x10)`, callback_data: `vw:${tca}:${tamt}:${fl}:${fv}` }]
                  ] 
              };
              await sendToChat(cid, `✅ *Pool:* ${pName}\n📈 *Vol:* ${v.toFixed(2)}\n💰 *Amt:* ${tamt} SOL\n\n🎯 *Pilih Strategi:*`, markup);
          }
        } else if (cmd === "/top") {
            if (handlers.top) {
                await sendToChat(cid, "🔍 Searching elite pools...");
                await sendToChat(cid, await handlers.top());
            }
        } else if (cmd === "/close") {
            if (handlers.close) await sendToChat(cid, await handlers.close(pts[1]));
        } else if (cmd === "/tp") {
            if (handlers.tp) await sendToChat(cid, await handlers.tp(pts[1], pts[2]));
        } else if (cmd === "/ar") {
            if (handlers.ar) await sendToChat(cid, await handlers.ar(pts[1], pts[2]));
        } else if (cmd === "/as") {
            if (handlers.as) await sendToChat(cid, await handlers.as(pts[1]));
        } else if (cmd === "/swap") {
            if (handlers.swap) await sendToChat(cid, await handlers.swap(pts[1]));
        } else if (cmd === "/cancel") {
            if (handlers.cancel) await sendToChat(cid, await handlers.cancel(pts[1]));
        } else if (cmd === "/lo") {
            const tamt = pts.slice(2).join(" ");
            if (handlers.lo) await handlers.lo(pts[1], tamt);
        } else if (cmd === "/set") {
            if (handlers.set) await sendToChat(cid, await handlers.set(pts[1], pts[2]));
        } else if (cmd === "/config") {
            if (handlers.config) await sendToChat(cid, await handlers.config());
        }
      }
    } catch (e) {
        if (e.name === 'AbortError') {
            // Long poll timed out or was aborted, this is normal behavior for Telegram polling
            return;
        }
        log("telegram_error", `Loop error: ${e.message}`);
    }
  };

  (async () => { while (true) { await poll(); await new Promise(r => setTimeout(r, 1000)); } })();
}
