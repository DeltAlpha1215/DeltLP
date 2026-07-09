import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "state.json");

/**
 * Mendapatkan semua posisi yang sedang dilacak.
 */
export function getTrackedPositions() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

/**
 * Melacak posisi baru.
 */
export function trackPosition(positionAddress, data) {
  const state = getTrackedPositions();
  state[positionAddress] = {
    ...data,
    trackedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Mendapatkan data satu posisi.
 */
export function getTrackedPosition(address) {
  return getTrackedPositions()[address];
}

/**
 * Memperbarui data posisi yang sudah ada tanpa menimpa semuanya.
 */
export function updateTrackedPosition(address, newData) {
  const state = getTrackedPositions();
  if (state[address]) {
    state[address] = {
      ...state[address],
      ...newData,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return true;
  }
  // Jika belum ada, buat baru
  trackPosition(address, newData);
  return true;
}

/**
 * Berhenti melacak posisi (setelah close).
 */
export function untrackPosition(address) {
  const state = getTrackedPositions();
  delete state[address];
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Memberikan instruksi/catatan khusus pada posisi.
 */
export function setPositionInstruction(address, instruction) {
  const state = getTrackedPositions();
  if (state[address]) {
    state[address].instruction = instruction;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
}

/**
 * Helper untuk CLI: set_position_note
 */
export function setPositionNote(address, note) {
    setPositionInstruction(address, note);
}

/**
 * Menandai posisi sebagai Out of Range (OOR)
 */
export function markOutOfRange(address) {
  const state = getTrackedPositions();
  if (state[address] && !state[address].oorSince) {
    state[address].oorSince = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
}

/**
 * Menandai posisi sebagai In Range
 */
export function markInRange(address) {
  const state = getTrackedPositions();
  if (state[address] && state[address].oorSince) {
    delete state[address].oorSince;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
}

/**
 * Mendapatkan durasi posisi sudah OOR dalam menit
 */
export function minutesOutOfRange(address) {
  const state = getTrackedPositions();
  const pos = state[address];
  if (!pos || !pos.oorSince) return 0;
  
  const oorAt = new Date(pos.oorSince).getTime();
  return Math.floor((Date.now() - oorAt) / 60000);
}

/**
 * Cek status automasi global.
 */
export function isAutomationEnabled() {
  const state = getTrackedPositions();
  return state._automationEnabled === true;
}

/**
 * Set status automasi global.
 */
export function setAutomationEnabled(enabled) {
  const state = getTrackedPositions();
  state._automationEnabled = enabled;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Record a closed position's base mint to track its cooldown.
 */
export function recordClosedPosition(mint) {
  if (!mint) return;
  const state = getTrackedPositions();
  if (!state._closedPositions) state._closedPositions = {};
  state._closedPositions[mint] = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Check if a base mint is currently in a 15-minute cooldown.
 */
export function isPositionInCooldown(mint) {
  if (!mint) return false;
  const state = getTrackedPositions();
  if (!state._closedPositions || !state._closedPositions[mint]) return false;
  
  const closedTime = new Date(state._closedPositions[mint]).getTime();
  const cooldownMs = 15 * 60 * 1000; // 15 minutes
  
  if (Date.now() - closedTime < cooldownMs) {
    return true;
  }
  
  // Clean up expired cooldown from state
  delete state._closedPositions[mint];
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return false;
}
