import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId   = process.env.TELEGRAM_CHAT_ID || null;
let _offset  = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch (error) {
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${error.message}`);
  }
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  if (incomingChatId !== chatId) return false;

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.");
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }

  return true;
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

function getActiveChatIds() {
    const envIds = (process.env.TELEGRAM_CHAT_ID || "").split(",").map(id => id.trim()).filter(Boolean);
    if (chatId && !envIds.includes(chatId)) envIds.push(chatId);
    return envIds;
}

async function postTelegram(method, body) {
  if (!TOKEN) return null;
  const targets = getActiveChatIds();
  if (targets.length === 0) return null;

  let lastRes = null;
  for (const targetId of targets) {
      try {
        const res = await fetch(`${BASE}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: targetId, ...body }),
        });
        if (!res.ok) {
          const err = await res.text();
          log("telegram_error", `${method} to ${targetId} ${res.status}: ${err.slice(0, 200)}`);
          continue;
        }
        lastRes = await res.json();
      } catch (e) {
          log("telegram_error", `Error sending to ${targetId}: ${e.message}`);
      }
  }
  return lastRes;
}

async function postTelegramRaw(method, body) {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

export async function sendMessage(text) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendMessageWithButtons(text, inlineKeyboard) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
}

export async function editMessage(text, messageId) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
  });
}

export async function editMessageWithButtons(text, messageId, inlineKeyboard) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

export function hasActiveLiveMessage() {
  return _liveMessageDepth > 0;
}

function createTypingIndicator() {
  if (!TOKEN || !chatId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name) {
  const labels = {
    get_token_info: "get token info",
    get_token_narrative: "get token narrative",
    get_token_holders: "get token holders",
    get_top_candidates: "get top candidates",
    get_pool_detail: "get pool detail",
    get_active_bin: "get active bin",
    deploy_position: "deploy position",
    close_position: "close position",
    claim_fees: "claim fees",
    swap_token: "swap token",
    update_config: "update config",
    get_my_positions: "get positions",
    get_wallet_balance: "get wallet balance",
    check_smart_wallets_on_pool: "check smart wallets",
    study_top_lpers: "study top LPers",
    get_top_lpers: "get top LPers",
    search_pools: "search pools",
    discover_pools: "discover pools",
  };
  return labels[name] || name.replace(/_/g, " ");
}

function summarizeToolResult(name, result) {
  if (!result) return "";
  if (result.error) return result.error;
  if (result.reason && result.blocked) return result.reason;
  switch (name) {
    case "deploy_position":
      return result.position ? `position ${String(result.position).slice(0, 8)}...` : "submitted";
    case "close_position":
      return result.success ? "closed" : (result.reason || "failed");
    case "claim_fees":
      return result.claimed_amount != null ? `claimed ${result.claimed_amount}` : "done";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} candidates`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} positions`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LPers`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

export async function createLiveMessage(title, intro = "Starting...") {
  if (!TOKEN || !chatId) return null;
  const typing = createTypingIndicator();

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function render() {
    const sections = [state.title];
    if (state.intro) sections.push(state.intro);
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    return sections.join("\n\n").slice(0, 4096);
  }

  async function flushNow() {
    state.flushTimer = null;
    state.flushRequested = false;
    const text = render();
    if (!state.messageId) {
      const sent = await sendMessage(text);
      state.messageId = sent?.result?.message_id ?? null;
      return;
    }
    await editMessage(text, state.messageId);
  }

  function scheduleFlush(delay = 300) {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => null);
    }, delay);
  }

  async function upsertToolLine(name, icon, suffix = "") {
    const label = toolLabel(name);
    const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name) {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name, result, success) {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const callback = update.callback_query;
        if (callback?.data && callback?.message) {
          const callbackMsg = {
            chat: callback.message.chat,
            from: callback.from,
            text: callback.data,
          };
          if (!isAuthorizedIncomingMessage(callbackMsg)) continue;
          await onMessage({
            ...callbackMsg,
            isCallback: true,
            callbackQueryId: callback.id,
            callbackData: callback.data,
            messageId: callback.message.message_id,
          });
          continue;
        }
        const msg = update.message;
        if (!msg?.text) continue;
        if (!isAuthorizedIncomingMessage(msg)) continue;
        await onMessage(msg);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage); // fire-and-forget
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, rangeCoverage, binStep, baseFee }) {
  if (hasActiveLiveMessage()) return;
  const priceStr = priceRange
    ? `Price range: ${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
    : "";
  const coverageStr = rangeCoverage
    ? `Range cover: ${fmtPct(rangeCoverage.downside_pct)} downside | ${fmtPct(rangeCoverage.upside_pct)} upside | ${fmtPct(rangeCoverage.width_pct)} total\n`
    : "";
  const poolStr = (binStep || baseFee)
    ? `Bin step: ${binStep ?? "?"}  |  Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n`
    : "";
  await sendHTML(
    `✅ <b>Deployed</b> ${pair}\n` +
    `Amount: ${amountSol} SOL\n` +
    priceStr +
    coverageStr +
    poolStr +
    `Position: <code>${position?.slice(0, 8)}...</code>\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyError(message) {
  if (getActiveChatIds().length === 0) return;
  await sendHTML(`❌ <b>ERROR ALERT</b>\n\n${message}`);
}

export async function notifyClose({ pair, pnlUsd, pnlPct }) {
  if (hasActiveLiveMessage() || getActiveChatIds().length === 0) return;
  
  const isProfit = pnlPct >= 0;
  const themeColor = isProfit ? '#00ffa3' : '#ff3b3b';
  const glowColor = isProfit ? 'rgba(0, 255, 163, 0.5)' : 'rgba(255, 59, 59, 0.5)';
  
  // Premium Aesthetic Card Configuration
  const chartConfig = {
    type: 'radialGauge',
    data: {
      datasets: [{
        data: [Math.min(Math.abs(pnlPct), 100)],
        backgroundColor: themeColor,
        borderWidth: 0,
      }]
    },
    options: {
      domain: [0, 100],
      trackColor: '#1a1a24',
      centerPercentage: 80,
      centerArea: {
        text: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`,
        fontColor: themeColor,
        fontSize: 50,
        fontWeight: '900'
      },
      title: {
        display: true,
        text: `CLOSED: ${pair.toUpperCase()}`,
        fontColor: '#8a8a9d',
        fontSize: 22,
        padding: 20
      }
    }
  };

  const cardUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&bkg=%230d0d12&w=600&h=400&v=2.9.4`;

  const unit = config.management.solMode ? "SOL" : "USD";
  const caption = `🏆 *POSITION FINALIZED*\n` +
                  `━━━━━━━━━━━━━━\n` +
                  `🪙 *Asset:* ${pair.toUpperCase()}\n` +
                  `📊 *PnL:* ${pnlPct >= 0 ? '🟢 +' : '🔴 '}${pnlPct.toFixed(2)}%\n` +
                  `💰 *Realized:* ${pnlUsd.toFixed(4)} ${unit}\n` +
                  `━━━━━━━━━━━━━━\n` +
                  `🚀 _Powered by DeltLP Hybrid Bot_`;

  console.log(`📤 Sending premium PnL Card for ${pair}...`);
  
  try {
      const res = await postTelegram("sendPhoto", {
        photo: cardUrl,
        caption,
        parse_mode: "Markdown"
      });
      if (res && res.ok) console.log("✅ Premium Card sent.");
  } catch (e) {
      log("telegram_error", `PnL Card fail: ${e.message}`);
      await sendHTML(`🔒 <b>Closed</b> ${pair}: ${pnlPct.toFixed(2)}%`);
  }
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `🔄 <b>Swapped</b> ${inputSymbol} → ${outputSymbol}\n` +
    `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `⚠️ <b>Out of Range</b> ${pair}\n` +
    `Been OOR for ${minutesOOR} minutes`
  );
}

export async function initTelegramBot(handlers = {}) {
  if (!TOKEN) {
    log("error", "TELEGRAM_BOT_TOKEN not set, bot control disabled.");
    return;
  }

  log("info", "Starting Telegram command listener...");
  let offset = 0;

  const poll = async () => {
    try {
      const res = await fetch(`${BASE}/getUpdates?offset=${offset}&timeout=30`);
      if (!res.ok) return;
      const json = await res.json();
      if (!json.ok || !json.result.length) return;

      for (const update of json.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg || !msg.text) continue;

        const chatId = msg.chat.id;
        const text = msg.text.trim();
        console.log(`📩 Telegram Message from ID [${chatId}]: "${text}"`);

        const parts = text.split(" ");
        const cmd = parts[0].toLowerCase();

        // Security check: Only respond to authorized chat IDs if set
        const authorizedEnv = process.env.TELEGRAM_CHAT_ID || "";
        const authorizedIds = authorizedEnv.split(",").map(id => id.trim());
        
        if (authorizedEnv && !authorizedIds.includes(String(chatId)) && !authorizedEnv.startsWith("@")) {
            console.log(`🚫 Unauthorized ID: ${chatId} (Expected one of: ${authorizedEnv})`);
            continue;
        }

        if (cmd === "/start" || cmd === "/help") {
          await sendMsg(chatId, "🤖 *Meridian Controller*\n\nAvailable commands:\n" +
                                "/status - Check PnL\n" +
                                "/buy <CA> [amt] [AS] [AR] - Buy token\n" +
                                "/close <index> - Manual TP/Exit\n" +
                                "/tp <on/off> <index> - Toggle Static TP\n" +
                                "/ar <on/off> <index> - Toggle Auto-Reentry\n" +
                                "/as <index> - Activate Auto-Swap\n" +
                                "/set <tp/sl> <value> - Global TP/SL (%)\n" +
                                "/config - View settings\n" +
                                "/cancel <CA> - Cancel pending order\n" +
                                "/swap <Mint> - Manual swap to SOL");
        } else if (cmd === "/status") {
          if (handlers.status) {
              const report = await handlers.status();
              await sendMsg(chatId, report);
          }
        } else if (cmd === "/buy") {
          const ca = parts[1];
          const args = parts.slice(2).join(" ");
          if (!ca) {
              await sendMsg(chatId, "Usage: /buy <CA> [amount] [AS] [AR]");
          } else {
              await sendMsg(chatId, `🚀 Starting buy for ${ca}...`);
              if (handlers.buy) handlers.buy(ca, args);
          }
        } else if (cmd === "/close") {
          const index = parts[1];
          if (!index) {
              await sendMsg(chatId, "Usage: /close <index>");
          } else if (handlers.close) {
              const res = await handlers.close(index);
              await sendMsg(chatId, res);
          }
        } else if (cmd === "/as") {
          const index = parts[1];
          if (!index) {
              await sendMsg(chatId, "Usage: /as <index>");
          } else if (handlers.as) {
              const res = await handlers.as(index);
              await sendMsg(chatId, res);
          }
        } else if (cmd === "/tp") {
          const mode = parts[1];
          const index = parts[2];
          if (!mode || !index) {
              await sendMsg(chatId, "Usage: /tp <on/off> <index>");
          } else if (handlers.tp) {
              const res = await handlers.tp(mode, index);
              await sendMsg(chatId, res);
          }
        } else if (cmd === "/ar") {
          const mode = parts[1];
          const index = parts[2];
          if (!mode || !index) {
              await sendMsg(chatId, "Usage: /ar <on/off> <index>");
          } else if (handlers.ar) {
              const res = await handlers.ar(mode, index);
              await sendMsg(chatId, res);
          }
        } else if (cmd === "/set") {
          const key = parts[1];
          const val = parts[2];
          if (!key || !val) {
              await sendMsg(chatId, "Usage: /set <tp/sl> <value>");
          } else if (handlers.set) {
              const res = await handlers.set(key, val);
              await sendMsg(chatId, res);
          }
        } else if (cmd === "/config") {
          if (handlers.config) {
              const res = await handlers.config();
              await sendMsg(chatId, res);
          }
        } else if (cmd === "/swap") {
          const mint = parts[1];
          if (!mint) {
              await sendMsg(chatId, "Usage: /swap <Mint_Address>");
          } else if (handlers.swap) {
              const res = await handlers.swap(mint);
              await sendMsg(chatId, res);
          }
        } else if (cmd === "/cancel") {
          const ca = parts[1];
          if (!ca) {
              await sendMsg(chatId, "Usage: /cancel <CA>");
          } else if (handlers.cancel) {
              const res = await handlers.cancel(ca);
              await sendMsg(chatId, res);
          }
        }
      }
    } catch (e) {
      log("error", `Telegram poll error: ${e.message}`);
    }
  };

  // Start polling loop
  (async () => {
    while (true) {
      await poll();
      await new Promise(r => setTimeout(r, 2000));
    }
  })();
}

async function sendMsg(chatId, text) {
    if (!BASE) return;
    try {
        await fetch(`${BASE}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                parse_mode: "Markdown"
            })
        });
    } catch (e) { /* ignore */ }
}
