import blessed from 'blessed';
import { log } from './logger.js';
import { config } from './config.js';
import { getWalletBalances } from './tools/wallet.js';
import { getMyPositions } from './tools/dlmm.js';
import { getTrackedPosition } from './state.js';

let screen;
let logBox;
let statusTable;
let walletBox;
let inputBar;
let commandHandler = null;

export function initTUI(handlers) {
    commandHandler = handlers;

    screen = blessed.screen({
        smartCSR: true,
        title: 'DeltLP Fibonacci Dashboard',
        fullUnicode: false, // Disable to prevent messy output in some WSL terminals
        dockBorders: true,
        useBCE: true
    });

    // 1. TOP: Status (Height: 3)
    walletBox = blessed.box({
        top: 0,
        left: 0,
        width: '100%',
        height: 3,
        label: ' [ STATUS ] ',
        border: { type: 'line' },
        style: { border: { fg: 'cyan' } },
        tags: true
    });

    // 2. MIDDLE-TOP: Active Positions (Height: 5)
    statusTable = blessed.box({
        top: 3,
        left: 0,
        width: '100%',
        height: 5,
        label: ' [ ACTIVE POSITIONS ] ',
        border: { type: 'line' },
        style: { border: { fg: 'yellow' } },
        tags: true,
        content: 'Loading positions...'
    });

    // 3. MIDDLE-BOTTOM: Activity Log (Safe height calculation)
    logBox = blessed.log({
        top: 8,
        left: 0,
        width: '100%',
        height: '100%-11', // 3 (wallet) + 5 (statusTable) + 3 (inputBar)
        label: ' [ ACTIVITY LOG ] ',
        border: { type: 'line' },
        style: { border: { fg: 'white' } },
        tags: true,
        scrollable: true,
        alwaysScroll: true,
        scrollbar: { ch: ' ', track: { bg: 'cyan' }, style: { inverse: true } }
    });

    // 4. VERY BOTTOM: Input Bar (Height: 3)
    inputBar = blessed.textbox({
        top: '100%-3',
        left: 0,
        width: '100%',
        height: 3,
        label: ' [ COMMAND ] ',
        border: { type: 'line' },
        style: { border: { fg: 'green' }, label: { fg: 'green', bold: true } },
        inputOnFocus: true,
        keys: true
    });

    screen.append(walletBox);
    screen.append(statusTable);
    screen.append(logBox);
    screen.append(inputBar);

    // Immediate console hijacking to prevent logs from messing up the layout
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    const handleLog = (...args) => {
        const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
        if (logBox && screen) {
            tuiLog(msg);
        } else {
            originalLog(...args);
        }
    };

    console.log = handleLog;
    console.warn = handleLog;
    console.error = handleLog;

    // Global Keys
    screen.key(['q', 'C-c'], () => process.exit(0));
    screen.key(['r'], async () => { await updateTUI(true); });
    screen.key(['escape'], () => { inputBar.focus(); screen.render(); });

    // PageUp / PageDown keys to scroll logBox
    screen.key(['pageup'], () => {
        if (logBox) {
            logBox.scroll(-10);
            screen.render();
        }
    });
    screen.key(['pagedown'], () => {
        if (logBox) {
            logBox.scroll(10);
            screen.render();
        }
    });


    inputBar.on('submit', async (text) => {
        const cmd = text.trim();
        if (cmd) {
            tuiLog(`{green-fg}User Command:{/green-fg} ${cmd}`);
            if (commandHandler && commandHandler.onCommand) await commandHandler.onCommand(cmd);
        }
        inputBar.clearValue();
        inputBar.focus();
        screen.render();
    });

    inputBar.focus();
    screen.render();

    screen.on('resize', () => {
        screen.render();
        updateTUI(true);
    });

    updateTUI(true);
    setInterval(() => updateTUI(false), 30000);
}

export function tuiLog(msg) {
    if (logBox && screen) {
        const time = new Date().toLocaleTimeString();
        const cleanMsg = String(msg).replace(/\u001b\[[0-9;]*m/g, ''); 
        logBox.log(`[{cyan-fg}${time}{/cyan-fg}] ${cleanMsg}`);
        screen.render();
    }
}

export async function updateTUI(force = false) {
    if (!screen || !walletBox || !statusTable) return;
    try {
        const balances = await getWalletBalances() || { sol: 0, wallet: 'N/A' };
        const feeStatus = config.management?.feeEnabled ? '{green-fg}ON{/green-fg}' : '{red-fg}OFF{/red-fg}';
        
        walletBox.setContent(
            ` SOL: {yellow-fg}${(balances.sol || 0).toFixed(4)}{/yellow-fg} | ` +
            `TP/SL: {green-fg}${config.management?.takeProfitPct ?? 0}%{/green-fg}/{red-fg}${config.management?.stopLossPct ?? 0}%{/red-fg} | ` +
            `Fee: ${feeStatus} | ` +
            `Wallet: ${balances.wallet ? String(balances.wallet).slice(0,6) + '...' + String(balances.wallet).slice(-4) : 'Not Set'}`
        );

        const posData = await getMyPositions({ force: force }) || {};
        const positions = Array.isArray(posData.positions) ? posData.positions : [];
        
        let content = ' {bold}Pair           | PnL     | Fee/TVL | Range | AS  | AR  | Mode{/bold}\n';
        content += ' ----------------------------------------------------------------\n';
        
        if (positions.length === 0) {
            content += ' No active positions';
        } else {
            positions.forEach(p => {
                if (!p) return;
                const tr = getTrackedPosition(p.position);
                const pair = String(p.pair || 'Unknown').padEnd(14).slice(0, 14);
                const pnl = `${(p.pnl_pct || 0).toFixed(2)}%`.padEnd(7);
                const feeTvl = `${(p.fee_per_tvl_24h || 0).toFixed(2)}%`.padEnd(7);
                const range = (p.in_range ? '{green-fg}IN{/green-fg}' : '{red-fg}OOR{/red-fg}').padEnd(20); // space for tags
                const as = (tr?.autoSwap ? 'ON ' : 'OFF').padEnd(3);
                const ar = (tr?.autoReentry ? 'ON ' : 'OFF').padEnd(3);
                const mode = String(tr?.tpMode || 'static').toUpperCase();
                
                content += ` ${pair} | ${pnl} | ${feeTvl} | ${range} | ${as} | ${ar} | ${mode}\n`;
            });
        }

        if (statusTable) {
            statusTable.setContent(content);
            screen.render();
        }
    } catch (e) {
        // TUI error log
        if (logBox) logBox.log(`[{red-fg}UI Error{/red-fg}] ${e.message}`);
    }
}
