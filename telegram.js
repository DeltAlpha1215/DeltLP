import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getPoolVolatility } from "./tools/meteora-top.js";
import { searchPools } from "./tools/dlmm.js";
import * as stateHelper from "./state.js";
import * as dlmm from "./tools/dlmm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

// Persistent Admin Chat ID
let currentAdminId = process.env.TELEGRAM_CHAT_ID || null;
let _offset = 0;
let _isPolling = false;

// State management for interactive editing
const userState = new Map(); // chatId -> { action: 'editing_tp' | 'editing_sl' | 'editing_cap' }

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
 * Delete a message from the Telegram chat
 */
async function deleteTelegramMessage(chatId, messageId) {
    if (!BASE || !chatId || !messageId) return;
    try {
        await fetch(`${BASE}/deleteMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, message_id: messageId })
        });
    } catch (e) {
        log("telegram_error", `Delete message failed: ${e.message}`);
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

async function editTelegramMessageMarkup(chatId, messageId, replyMarkup) {
    if (!BASE || !chatId || !messageId) return;
    try {
        await fetch(`${BASE}/editMessageReplyMarkup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                message_id: messageId,
                reply_markup: replyMarkup
            })
        });
    } catch (e) {
        log("telegram_error", `Edit reply markup failed: ${e.message}`);
    }
}

async function setupAndSendLpMenu(cid, tca, tamt) {
    await sendToChat(cid, `🔍 Identifying pool for \`${tca.slice(0,12)}...\``);
    
    let v = 0, pName = "Unknown", pAddr = null;
    try { 
        // Find pool using searchPools
        const searchRes = await searchPools({ query: tca, limit: 10 });
        const solPools = (searchRes.pools || []).filter(p => p.name.includes("-SOL") || p.name.includes("SOL-"));
        
        if (solPools.length > 0) {
            const bestPool = solPools[0];
            pName = bestPool.name;
            pAddr = bestPool.pool;
            
            const pInf = await getPoolVolatility(pAddr); 
            v = pInf ? pInf.volatility : 0;
        }
    } catch (err) { 
        log("telegram_error", `Pool identification failed: ${err.message}`);
    }

    if (pName === "Unknown") {
        await sendToChat(cid, "❌ Pool SOL tidak ditemukan untuk CA tersebut. Pastikan CA benar.");
        return;
    }

    // Save configuration in state
    userState.set(cid, {
        action: "configuring_lp",
        ca: tca,
        amount: tamt,
        as: false,
        ar: false,
        poolName: pName,
        volatility: v
    });

    await sendLpMenuMessage(cid, pName, v, tamt, false, false);
}

async function sendLpMenuMessage(cid, poolName, volatility, amount, asState, arState) {
    const text = `✅ *Pool:* ${poolName}\n📈 *Vol:* ${volatility.toFixed(2)}\n💰 *Amount:* ${amount} SOL\n\n🎯 *Atur Opsi & Pilih Strategi:*`;
    
    const markup = { 
        inline_keyboard: [
            [
                { text: `🔄 Auto-Swap: ${asState ? '✅' : '❌'}`, callback_data: "c_as" },
                { text: `🔁 Auto-Reentry: ${arState ? '✅' : '❌'}`, callback_data: "c_ar" }
            ],
            [{ text: "📉 Deploy Fibonacci", callback_data: "c_fib" }], 
            [
                { text: "🎯 Limit Order (Bid-Ask)", callback_data: "c_lo_ba" },
                { text: "🎯 Limit Order (Spot)", callback_data: "c_lo_spot" }
            ],
            [
                { text: "📊 Tight Vol (x5)", callback_data: "c_vol5" },
                { text: "📊 Wide Vol (x10)", callback_data: "c_vol10" }
            ],
            [{ text: "⬅️ Cancel", callback_data: "m_m" }]
        ] 
    };
    
    await sendToChat(cid, text, markup);
}

async function updateLpMenuReplyMarkup(cid, messageId, asState, arState) {
    const markup = { 
        inline_keyboard: [
            [
                { text: `🔄 Auto-Swap: ${asState ? '✅' : '❌'}`, callback_data: "c_as" },
                { text: `🔁 Auto-Reentry: ${arState ? '✅' : '❌'}`, callback_data: "c_ar" }
            ],
            [{ text: "📉 Deploy Fibonacci", callback_data: "c_fib" }], 
            [
                { text: "🎯 Limit Order (Bid-Ask)", callback_data: "c_lo_ba" },
                { text: "🎯 Limit Order (Spot)", callback_data: "c_lo_spot" }
            ],
            [
                { text: "📊 Tight Vol (x5)", callback_data: "c_vol5" },
                { text: "📊 Wide Vol (x10)", callback_data: "c_vol10" }
            ],
            [{ text: "⬅️ Cancel", callback_data: "m_m" }]
        ] 
    };
    await editTelegramMessageMarkup(cid, messageId, markup);
}

async function sendAutomationDashboard(cid, isAuto) {
    const autoStatus = isAuto ? "✅ ON" : "❌ OFF";
    const solAmt = config.management.deployAmountSol || 0.05;
    let text = `🤖 *Automation Dashboard*\nStatus: *${autoStatus}*\n💰 *SOL Amount:* ${solAmt} SOL\n\n`;
    
    try {
        const posData = await dlmm.getMyPositions({ force: true, silent: true });
        const activePositions = posData.positions || [];
        
        text += `📊 *Active Positions (${activePositions.length}/3):*\n`;
        const keyboard = [];
        
        activePositions.forEach((p, index) => {
            text += `${index + 1}. *${p.pair}* | PnL: \`${(p.pnl_pct || 0).toFixed(2)}%\`\n`;
            keyboard.push([{ text: `❌ Close Pos #${index + 1} (${p.pair})`, callback_data: `c_close_pos:${p.position}` }]);
        });
        
        if (activePositions.length === 0) {
            text += "_Tidak ada posisi aktif._\n";
        }
        
        keyboard.push([
            { text: `💰 Set Auto SOL (${solAmt} SOL)`, callback_data: "c_set_auto_sol" }
        ]);
        keyboard.push([
            { text: isAuto ? "🔴 Turn OFF Automation" : "🟢 Turn ON Automation", callback_data: "c_toggle_auto" }
        ]);
        keyboard.push([
            { text: "🚨 EMERGENCY CLOSE ALL", callback_data: "c_panic_confirm" }
        ]);
        keyboard.push([{ text: "⬅️ Back to Menu", callback_data: "m_m" }]);
        
        await sendToChat(cid, text, { inline_keyboard: keyboard });
    } catch (e) {
        log("telegram_error", `Dashboard load failed: ${e.message}`);
        await sendToChat(cid, "❌ Gagal memuat dashboard automasi.");
    }
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
      
      const updates = json.result || [];
      if (updates.length > 0) {
          log("info", `Received ${updates.length} updates.`);
      }

      if (!updates.length) return;

      for (const update of updates) {
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
                userState.set(cid, { action: "waiting_for_ca" });
                await sendToChat(cid, "📝 *Masukkan Contract Address (CA) token Solana*:\n(Bisa menyertakan jumlah SOL juga, contoh: `CA_TOKEN` atau `CA_TOKEN 0.05` atau ketik `/cancel` untuk membatalkan)");
            } else if (data === "m_s") {
                if (handlers.status) {
                    const res = await handlers.status();
                    if (typeof res === "object") await sendToChat(cid, res.text, res.buttons);
                    else await sendToChat(cid, res);
                }
            } else if (data === "m_t") {
                if (handlers.top) {
                    await sendToChat(cid, "🔍 Scanning elite pools...");
                    await sendToChat(cid, await handlers.top());
                }
            } else if (data === "m_c") {
                if (handlers.config) {
                    const res = await handlers.config();
                    if (typeof res === "object") await sendToChat(cid, res.text, res.buttons);
                    else await sendToChat(cid, res);
                }
            } else if (data === "c_fee_on") {
                if (handlers.set) await handlers.set("fee", "on");
                if (handlers.config) {
                    const res = await handlers.config();
                    await sendToChat(cid, res.text, res.buttons);
                }
            } else if (data === "c_fee_off") {
                if (handlers.set) await handlers.set("fee", "off");
                if (handlers.config) {
                    const res = await handlers.config();
                    await sendToChat(cid, res.text, res.buttons);
                }
            } else if (data === "c_dry_on" || data === "c_dry_off") {
                if (handlers.set_dryrun) {
                    await handlers.set_dryrun(data === "c_dry_on" ? "true" : "false");
                }
                if (handlers.config) {
                    const res = await handlers.config();
                    await sendToChat(cid, res.text, res.buttons);
                }
            } else if (data === "c_set_tp") {
                userState.set(cid, { action: "editing_tp" });
                await sendToChat(cid, "📝 Masukkan nilai *Global Take Profit* baru (%):\n(Contoh: `10` untuk 10%)");
            } else if (data === "c_set_sl") {
                userState.set(cid, { action: "editing_sl" });
                await sendToChat(cid, "📝 Masukkan nilai *Global Stop Loss* baru (%):\n(Contoh: `-15` untuk -15%)");
            } else if (data === "c_set_cap") {
                userState.set(cid, { action: "editing_cap" });
                await sendToChat(cid, "📝 Masukkan nilai *Max SOL Cap* baru (SOL):\n(Contoh: `1.5`) \n\n_Batas total modal yang boleh digunakan bot._");
            } else if (data === "c_set_wallet") {
                userState.set(cid, { action: "editing_wallet" });
                await sendToChat(cid, "🔑 *Masukkan Private Key Solana (Base58)* baru:\n\n⚠️ _Security note: Pesan Anda akan langsung dihapus otomatis oleh bot setelah dibaca demi keamanan._");
            } else if (data === "m_m") {
                const autoStatus = stateHelper.isAutomationEnabled() ? "✅ ON" : "❌ OFF";
                const mm = { 
                    inline_keyboard: [
                        [{ text: "🎯 Open Position", callback_data: "m_o" }, { text: "📊 Status", callback_data: "m_s" }],
                        [{ text: "🔥 Top Pools", callback_data: "m_t" }, { text: "⚙️ Config", callback_data: "m_c" }],
                        [{ text: `🤖 Automation: ${autoStatus}`, callback_data: "c_auto_dash" }]
                    ] 
                };
                await sendToChat(cid, "🤖 *DeltLP Interactive Menu*", mm);
            } else if (data === "c_as" || data === "c_ar") {
                const st = userState.get(cid);
                if (st && st.action === "configuring_lp") {
                    if (data === "c_as") st.as = !st.as;
                    if (data === "c_ar") st.ar = !st.ar;
                    await updateLpMenuReplyMarkup(cid, cb.message.message_id, st.as, st.ar);
                }
                continue;
            } else if (data === "c_fib" || data === "c_vol5" || data === "c_vol10" || data === "c_lo_ba" || data === "c_lo_spot") {
                const st = userState.get(cid);
                if (st && st.action === "configuring_lp") {
                    userState.delete(cid); // Clear state
                    
                    let arg = "";
                    if (st.as) arg += "AS ";
                    if (st.ar) arg += "AR";
                    arg = arg.trim();

                    let strategyText = "";
                    if (data === "c_fib") {
                        strategyText = "Fibonacci";
                        await sendToChat(cid, `📉 Memulai LP Fibonacci untuk ${st.ca.slice(0,8)}...`);
                        if (handlers.lp) await handlers.lp(st.ca, `${st.amount} ${arg}`);
                    } else if (data === "c_vol5") {
                        strategyText = "Tight Vol (x5)";
                        await sendToChat(cid, `📊 Memulai LP Tight Vol (x5) untuk ${st.ca.slice(0,8)}...`);
                        if (handlers.lp_vol) await handlers.lp_vol(st.ca, `${st.amount} ${arg} M5 V${(st.volatility || 2.0).toFixed(1)}`);
                    } else if (data === "c_vol10") {
                        strategyText = "Wide Vol (x10)";
                        await sendToChat(cid, `📊 Memulai LP Wide Vol (x10) untuk ${st.ca.slice(0,8)}...`);
                        if (handlers.lp_vol) await handlers.lp_vol(st.ca, `${st.amount} ${arg} M10 V${(st.volatility || 2.0).toFixed(1)}`);
                    } else if (data === "c_lo_ba") {
                        strategyText = "Limit Order (Bid-Ask)";
                        await sendToChat(cid, `🎯 Memulai Limit Order (Bid-Ask) untuk ${st.ca.slice(0,8)}...`);
                        if (handlers.set_lo) await handlers.set_lo(st.ca, st.amount, "BA", st.as, st.ar);
                    } else if (data === "c_lo_spot") {
                        strategyText = "Limit Order (Spot)";
                        await sendToChat(cid, `🎯 Memulai Limit Order (Spot) untuk ${st.ca.slice(0,8)}...`);
                        if (handlers.set_lo) await handlers.set_lo(st.ca, st.amount, "SPOT", st.as, st.ar);
                    }
                    
                    // Replace/delete options menu so it cannot be double-clicked
                    try {
                        await fetch(`${BASE}/editMessageText`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                chat_id: cid,
                                message_id: cb.message.message_id,
                                text: `✅ *Deployment Sent:* ${st.poolName}\n🎯 *Strategy:* ${strategyText}\n💰 *Amount:* ${st.amount} SOL\n🔧 *Options:* ${arg || "None"}`
                            })
                        });
                    } catch (e) {}
                }
                continue;
            } else if (data === "c_auto_dash") {
                const isAuto = stateHelper.isAutomationEnabled();
                await sendAutomationDashboard(cid, isAuto);
                continue;
            } else if (data === "c_set_auto_sol") {
                userState.set(cid, { action: "editing_auto_sol" });
                await sendToChat(cid, "📝 Masukkan jumlah SOL baru untuk Auto-Deploy:\n(Contoh: `0.1` untuk 0.1 SOL)");
                continue;
            } else if (data === "c_toggle_auto") {
                if (handlers.toggle_automation) {
                    const nextState = await handlers.toggle_automation();
                    await sendAutomationDashboard(cid, nextState);
                }
                continue;
            } else if (data.startsWith("c_close_pos:")) {
                const posAddr = data.split(":")[1];
                await sendToChat(cid, `⏳ Menutup posisi \`${posAddr.slice(0,8)}...\`...`);
                if (handlers.close_position) {
                    const resMsg = await handlers.close_position(posAddr);
                    await sendToChat(cid, resMsg);
                }
                setTimeout(async () => {
                    const isAuto = stateHelper.isAutomationEnabled();
                    await sendAutomationDashboard(cid, isAuto);
                }, 4000);
            } else if (data.startsWith("c_edit_tp:") || data.startsWith("c_edit_sl:")) {
                const parts = data.split(":");
                const type = parts[0] === "c_edit_tp" ? "tp" : "sl";
                const posAddr = parts[1];
                
                userState.set(cid, { action: `editing_pos_${type}`, pos: posAddr });
                await sendToChat(cid, `📝 Masukkan nilai *${type.toUpperCase()}* baru (%) untuk posisi \`${posAddr.slice(0,8)}...\`:\n(Contoh: \`10\` untuk 10%, atau \`-15\` untuk -15%)`);
                continue;
            } else if (data.startsWith("c_toggle_tpmode:")) {
                const posAddr = data.split(":")[1];
                const tracked = stateHelper.getTrackedPosition(posAddr) || {};
                const current = tracked.tpMode || "bb_rsi";
                
                let curLabel = "BB+RSI";
                if (current === "static") curLabel = "Static %";
                if (current === "trailing") curLabel = "Trailing";
                
                const mm = { 
                    inline_keyboard: [
                        [{ text: "📊 Static %", callback_data: `c_set_tpmode:${posAddr}:static` }],
                        [{ text: "📈 Trailing", callback_data: `c_set_tpmode:${posAddr}:trailing` }],
                        [{ text: "📉 BB + RSI", callback_data: `c_set_tpmode:${posAddr}:bb_rsi` }],
                        [{ text: "⬅️ Batal", callback_data: "m_s" }]
                    ] 
                };
                await sendToChat(cid, `🔄 *Pilih Mode Take Profit untuk Posisi \`${posAddr.slice(0,8)}...\`*\n\nMode saat ini: *${curLabel}*`, mm);
                continue;
            } else if (data.startsWith("c_set_tpmode:")) {
                const parts = data.split(":");
                const posAddr = parts[1];
                const selectedMode = parts[2];
                
                stateHelper.updateTrackedPosition(posAddr, { tpMode: selectedMode });
                
                let modeLabel = "BB+RSI";
                if (selectedMode === "static") modeLabel = "Static %";
                if (selectedMode === "trailing") modeLabel = "Trailing";
                
                await sendToChat(cid, `✅ Mode TP posisi \`${posAddr.slice(0,8)}...\` diubah ke: *${modeLabel}*`);
                
                if (handlers.status) {
                    const res = await handlers.status();
                    if (typeof res === "object") await sendToChat(cid, res.text, res.buttons);
                    else await sendToChat(cid, res);
                }
                continue;
            } else if (data === "c_panic_confirm") {
                const mm = { 
                    inline_keyboard: [
                        [{ text: "⚠️ YA, TUTUP SEMUA POSISI!", callback_data: "c_panic_execute" }],
                        [{ text: "❌ BATAL", callback_data: "m_m" }]
                    ] 
                };
                await sendToChat(cid, "🚨 *KONFIRMASI DARURAT*\n\nApakah Anda yakin ingin melikuidasi seluruh posisi aktif di Meteora dan menukar semua koin kembali ke SOL secara instan?", mm);
                continue;
            } else if (data === "c_panic_execute") {
                await sendToChat(cid, "🚨 *Memulai Likuidasi Darurat Seluruh Posisi...*");
                if (handlers.emergency_close) {
                    const resultMsg = await handlers.emergency_close();
                    await sendToChat(cid, resultMsg);
                }
                continue;
            }

            continue;
        }

        // --- 2. Handle Messages ---
        const msg = update.message;
        if (!msg || !msg.text) continue;
        
        const text = msg.text.trim();
        const pts = text.split(" ");
        const cmd = pts[0].toLowerCase();
        const state = userState.get(cid);

        // Redact private keys from printed logs
        let logText = text;
        if (cmd === "/wallet" || cmd === "/setwallet" || (state && state.action === "editing_wallet")) {
            logText = (cmd === "/wallet" || cmd === "/setwallet") ? `${pts[0]} [REDACTED_PRIVATE_KEY]` : "[REDACTED_PRIVATE_KEY]";
        }
        log("info", `Telegram Message from ${cid} (@${msg.from.username || "unknown"}): ${logText}`);

        // Handle active state editing
        if (state) {
            if (state.action === "editing_pos_tp" || state.action === "editing_pos_sl") {
                const posAddr = state.pos;
                userState.delete(cid); // Clear state
                const val = parseFloat(text.replace(",", "."));
                
                if (isNaN(val)) {
                    await sendToChat(cid, "❌ Input tidak valid. Harus berupa angka.");
                } else {
                    const updateObj = {};
                    if (state.action === "editing_pos_tp") {
                        updateObj.takeProfitPct = val;
                        await sendToChat(cid, `✅ TP posisi \`${posAddr.slice(0,8)}...\` diatur ke: ${val}%`);
                    } else {
                        updateObj.stopLossPct = val;
                        await sendToChat(cid, `✅ SL posisi \`${posAddr.slice(0,8)}...\` diatur ke: ${val}%`);
                    }
                    stateHelper.updateTrackedPosition(posAddr, updateObj);
                }
                continue;
            }

            if (state.action === "editing_auto_sol") {
                userState.delete(cid); // Clear state
                const val = parseFloat(text.replace(",", "."));
                if (isNaN(val) || val <= 0) {
                    await sendToChat(cid, "❌ Input tidak valid. Harus berupa angka positif.");
                } else {
                    config.management.deployAmountSol = val;
                    try {
                        const filePath = path.join(__dirname, "user-config.json");
                        let current = {};
                        if (fs.existsSync(filePath)) {
                            current = JSON.parse(fs.readFileSync(filePath, "utf8"));
                        }
                        current.deployAmountSol = val;
                        fs.writeFileSync(filePath, JSON.stringify(current, null, 2));
                    } catch (e) {
                        log("error", `Failed to save deployAmountSol to user-config.json: ${e.message}`);
                    }
                    
                    await sendToChat(cid, `✅ Jumlah Auto SOL diatur ke: ${val} SOL`);
                    await sendAutomationDashboard(cid, stateHelper.isAutomationEnabled());
                }
                continue;
            }

            if (state.action === "editing_wallet") {
                userState.delete(cid); // Clear state
                // Delete message containing private key immediately
                await deleteTelegramMessage(cid, msg.message_id);
                
                let resMsg = "❌ Wallet update failed.";
                if (handlers.setwallet) {
                    const res = await handlers.setwallet(text);
                    if (res.success) {
                        resMsg = `✅ *Wallet Updated Successfully!*\nNew Public Key: \`${res.publicKey}\``;
                    } else {
                        resMsg = `❌ *Wallet Update Failed:*\n${res.error || "Unknown error"}`;
                    }
                }
                await sendToChat(cid, resMsg);
                continue;
            }

            if (state.action === "waiting_for_ca") {
                userState.delete(cid); // Clear state
                if (text.toLowerCase() === "/cancel") {
                    await sendToChat(cid, "❌ Deployment dibatalkan.");
                    continue;
                }
                const parts = text.split(" ");
                const tca = parts[0];
                const tamt = parts[1] || "0.001";
                await setupAndSendLpMenu(cid, tca, tamt);
                continue;
            }

            userState.delete(cid); // Clear state
            const val = parseFloat(text.replace(",", "."));
            if (isNaN(val)) {
                await sendToChat(cid, "❌ Input tidak valid. Harus berupa angka.");
            } else {
                let resMsg = "";
                if (state.action === "editing_tp") {
                    if (handlers.set) resMsg = await handlers.set("tp", text);
                } else if (state.action === "editing_sl") {
                    if (handlers.set) resMsg = await handlers.set("sl", text);
                } else if (state.action === "editing_cap") {
                    config.management.globalMaxCapSol = val;
                    resMsg = `✅ Max SOL Cap diatur ke: ${val} SOL`;
                }
                
                await sendToChat(cid, resMsg);
                if (handlers.config) {
                    const cfg = await handlers.config();
                    await sendToChat(cid, cfg.text, cfg.buttons);
                }
            }
            continue;
        }
        
        if (cmd === "/menu" || cmd === "/start") {
          const autoStatus = stateHelper.isAutomationEnabled() ? "✅ ON" : "❌ OFF";
          const mm = { 
              inline_keyboard: [
                  [{ text: "🎯 Open Position", callback_data: "m_o" }, { text: "📊 Status", callback_data: "m_s" }],
                  [{ text: "🔥 Top Pools", callback_data: "m_t" }, { text: "⚙️ Config", callback_data: "m_c" }],
                  [{ text: `🤖 Automation: ${autoStatus}`, callback_data: "c_auto_dash" }]
              ] 
          };
          await sendToChat(cid, "🤖 *DeltLP Interactive Menu*", mm);
        } else if (cmd === "/status") {
          if (handlers.status) {
              const res = await handlers.status();
              if (typeof res === "object") await sendToChat(cid, res.text, res.buttons);
              else await sendToChat(cid, res);
          }
        } else if (cmd === "/lp") {
          const tca = pts[1];
          const tamt = pts[2] || "0.001";
          if (!tca) { 
              await sendToChat(cid, "Usage: /lp <CA> [amount]"); 
          } else {
              await setupAndSendLpMenu(cid, tca, tamt);
          }
        } else if (cmd === "/dryrun") {
            if (handlers.set_dryrun) {
                const nextVal = process.env.DRY_RUN === "true" ? "false" : "true";
                const resMsg = await handlers.set_dryrun(nextVal);
                await sendToChat(cid, resMsg);
            }
        } else if (cmd === "/panic") {
            const mm = { 
                inline_keyboard: [
                    [{ text: "⚠️ YA, TUTUP SEMUA POSISI!", callback_data: "c_panic_execute" }],
                    [{ text: "❌ BATAL", callback_data: "m_m" }]
                ] 
            };
            await sendToChat(cid, "🚨 *KONFIRMASI DARURAT*\n\nApakah Anda yakin ingin melikuidasi seluruh posisi aktif di Meteora dan menukar semua koin kembali ke SOL secara instan?", mm);
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
        } else if (cmd === "/wallet" || cmd === "/setwallet") {
            // Delete message containing private key immediately
            await deleteTelegramMessage(cid, msg.message_id);
            
            const pKey = pts[1];
            if (!pKey) {
                await sendToChat(cid, "Usage: `/wallet <private_key>` or `/setwallet <private_key>`");
            } else {
                let resMsg = "❌ Wallet update failed.";
                if (handlers.setwallet) {
                    const res = await handlers.setwallet(pKey);
                    if (res.success) {
                        resMsg = `✅ *Wallet Updated Successfully!*\nNew Public Key: \`${res.publicKey}\``;
                    } else {
                        resMsg = `❌ *Wallet Update Failed:*\n${res.error || "Unknown error"}`;
                    }
                }
                await sendToChat(cid, resMsg);
            }
        } else if (cmd === "/config") {
            if (handlers.config) {
                const res = await handlers.config();
                if (typeof res === "object") await sendToChat(cid, res.text, res.buttons);
                else await sendToChat(cid, res);
            }
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
