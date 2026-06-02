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
