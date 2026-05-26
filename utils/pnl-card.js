import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Generate a professional PnL Card HTML
 */
export function getPnlCardHtml(pair, pnlPct, pnlUsd) {
    const isProfit = pnlPct >= 0;
    const themeColor = isProfit ? "#00ffa3" : "#ff3b3b";
    const statusText = isProfit ? "TAKE PROFIT" : "STOP LOSS";
    const pnlSign = isProfit ? "+" : "";

    return `
    <html>
    <head>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap');
            body {
                width: 600px;
                height: 350px;
                background: #0d0d12;
                margin: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                font-family: 'Inter', sans-serif;
                color: white;
            }
            .card {
                width: 540px;
                height: 290px;
                background: linear-gradient(135deg, #1a1a24 0%, #0d0d12 100%);
                border: 1px solid #2d2d3d;
                border-radius: 24px;
                padding: 30px;
                position: relative;
                overflow: hidden;
                box-shadow: 0 20px 40px rgba(0,0,0,0.4);
            }
            .card::before {
                content: '';
                position: absolute;
                top: -50%;
                left: -50%;
                width: 200%;
                height: 200%;
                background: radial-gradient(circle, ${themeColor}10 0%, transparent 70%);
                z-index: 0;
            }
            .header {
                position: relative;
                z-index: 1;
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 20px;
            }
            .pair {
                font-size: 28px;
                font-weight: 900;
                letter-spacing: -0.5px;
            }
            .status {
                background: ${themeColor}20;
                color: ${themeColor};
                padding: 6px 14px;
                border-radius: 12px;
                font-size: 14px;
                font-weight: 700;
                border: 1px solid ${themeColor}40;
            }
            .pnl-container {
                position: relative;
                z-index: 1;
                margin-top: 40px;
            }
            .pnl-label {
                font-size: 16px;
                color: #8a8a9d;
                margin-bottom: 8px;
            }
            .pnl-value {
                font-size: 72px;
                font-weight: 900;
                color: ${themeColor};
                letter-spacing: -3px;
                line-height: 1;
            }
            .pnl-usd {
                font-size: 20px;
                color: #8a8a9d;
                margin-top: 10px;
            }
            .footer {
                position: absolute;
                bottom: 30px;
                left: 30px;
                right: 30px;
                z-index: 1;
                display: flex;
                justify-content: space-between;
                border-top: 1px solid #2d2d3d;
                padding-top: 20px;
                color: #5d5d6d;
                font-size: 12px;
                font-weight: 600;
            }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="header">
                <div class="pair">${pair.toUpperCase()}</div>
                <div class="status">${statusText}</div>
            </div>
            <div class="pnl-container">
                <div class="pnl-label">Cumulative PnL</div>
                <div class="pnl-value">${pnlSign}${pnlPct.toFixed(2)}%</div>
                <div class="pnl-usd">≈ ${pnlUsd.toFixed(4)} SOL Profit</div>
            </div>
            <div class="footer">
                <div>MERIDIAN HYBRID BOT</div>
                <div>${new Date().toLocaleString()}</div>
            </div>
        </div>
    </body>
    </html>
    `;
}
