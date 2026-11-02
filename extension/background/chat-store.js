/**
 * Persistence helpers for grounded page chat (Slice 2.1).
 * Threads live under a single `chat.thread` key in chrome.storage.session
 * (architecture §12), keyed by tab ID.
 */

export const CHAT_THREAD_KEY = "chat.thread";

const MAX_TURNS = 12;
const MAX_HISTORY_CHARS = 12000;

/**
 * Reads the per-tab thread map. Never throws (falls back to empty).
 * @returns {Promise<Record<string, { url: string, turns: Array<{role: string, text: string, at: string}> }>>}
 */
export async function readThreads() {
  try {
    const stored = await chrome.storage.session.get(CHAT_THREAD_KEY);
    const threads = stored?.[CHAT_THREAD_KEY];
    return threads && typeof threads === "object" ? threads : {};
  } catch {
    return {};
  }
}

/**
 * Persists the per-tab thread map. Never throws.
 * @param {object} threads
 */
export async function writeThreads(threads) {
  try {
    await chrome.storage.session.set({ [CHAT_THREAD_KEY]: threads });
  } catch {
    // Session storage may be unavailable (e.g. cleared mid-turn); the current turn still works.
  }
}

/**
 * Edge case 2.1-04: caps history so the oldest turns are dropped first,
 * while always keeping room for the latest exchange.
 * @param {Array<{role: string, text: string, at: string}>} turns
 * @returns {Array<{role: string, text: string, at: string}>}
 */
export function trimTurns(turns) {
  if (!Array.isArray(turns)) return [];

  const recent = turns.slice(-MAX_TURNS);
  const kept = [];
  let total = 0;

  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const turn = recent[i];
    const size = typeof turn?.text === "string" ? turn.text.length : 0;
    // Always keep the last two turns (the latest exchange) regardless of size.
    if (kept.length >= 2 && total + size > MAX_HISTORY_CHARS) break;
    total += size;
    kept.unshift(turn);
  }

  return kept;
}

/**
 * Returns the stored thread for a tab, resetting it when the page URL changed
 * (Edge case 2.1-03: navigation must not answer the new page from the old extract).
 * @param {number} tabId
 * @param {string} currentUrl
 * @returns {Promise<{ url: string, turns: Array<{role: string, text: string, at: string}>, contextChanged: boolean }>}
 */
export async function getThreadEntry(tabId, currentUrl) {
  const threads = await readThreads();
  const entry = threads[String(tabId)];

  if (!entry || entry.url !== currentUrl) {
    return {
      url: currentUrl,
      turns: [],
      contextChanged: Boolean(entry?.turns?.length)
    };
  }

  return { url: entry.url, turns: entry.turns || [], contextChanged: false };
}
