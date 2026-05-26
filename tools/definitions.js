const toolDefinitions = [
  // ═══════════════════════════════════════════
  //  CORE TRADING TOOLS (DETERMINISTIC)
  // ═══════════════════════════════════════════
  {
    type: "function",
    function: {
      name: "search_pools",
      description: `Search for DLMM pools by token symbol, ticker, or contract address (CA).
Returns pool address, name, bin_step, fee %, TVL, volume, and token mints.`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Token symbol or CA to search for" },
          limit: { type: "number", description: "Max results to return (default 10)" }
        },
        required: ["query"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "deploy_position",
      description: `Open a new DLMM liquidity position. Dynamic Fibonacci Mode enabled.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: { type: "string", description: "The DLMM pool address" },
          amount_sol: { type: "number", description: "Amount of SOL to deposit" },
          strategy: { type: "string", enum: ["bid_ask", "spot"], default: "bid_ask" },
          bins_below: { type: "number", description: "Number of bins below active price" },
          bins_above: { type: "number", description: "Number of bins above active price (default 0)" }
        },
        required: ["pool_address", "amount_sol"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "close_position",
      description: `Remove all liquidity and close a position. Auto-swaps base token back to SOL.`,
      parameters: {
        type: "object",
        properties: {
          position_address: { type: "string", description: "The position public key to close" },
          reason: { type: "string", description: "Exit reason (TP/SL/Manual)" }
        },
        required: ["position_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_position_pnl",
      description: `Get real-time PnL and metrics for an open position.`,
      parameters: {
        type: "object",
        properties: {
          pool_address: { type: "string", description: "The pool address" },
          position_address: { type: "string", description: "The position public key" }
        },
        required: ["pool_address", "position_address"]
      }
    }
  },

  {
    type: "function",
    function: {
      name: "get_my_positions",
      description: `List all open DLMM positions for the agent wallet.`,
      parameters: { type: "object", properties: {} }
    }
  },

  {
    type: "function",
    function: {
      name: "get_wallet_balance",
      description: `Get current SOL and token balances.`,
      parameters: { type: "object", properties: {} }
    }
  }
];

export const tools = toolDefinitions.map((tool) => ({
  ...tool,
  function: {
    ...tool.function,
    parameters: tool.function.parameters?.type === "object"
      ? { additionalProperties: false, ...tool.function.parameters }
      : tool.function.parameters,
  },
}));
