/**
 * AgentSession persistence helpers (Slice 3.4).
 *
 * Checkpoints are written to chrome.storage.session (cleared on browser close)
 * with a silent fallback to chrome.storage.local (survives browser restarts)
 * so the session outlives service-worker sleep in both scenarios.
 *
 * Architecture §8.6 shape:
 * {
 *   id, tabId, urlAtStart, goal, maxSteps, step, scanGeneration,
 *   status, pendingAction, dryRun, log, message, updatedAt
 * }
 *
 * Hard rule: the session is NEVER auto-executed on restore.
 * A restored awaiting_approval session is re-broadcast as AGENT_STATE so the
 * panel can re-show the proposal, but nothing touches the DOM until the user
 * taps Approve again.
 */

const SESSION_KEY = "agent.session";

/**
 * Serialises a session snapshot to both storage areas.
 * Called before every point where the SW might sleep (i.e. before waiting for
 * user input — right after a proposal is ready).
 *
 * @param {object} session The live session object from loop.js.
 * @returns {Promise<void>}
 */
export async function persistSession(session) {
  if (!session) return;

  // Clamp the snapshot: pendingAction's node object has DOM-derived bbox which
  // doesn't survive serialisation gracefully for highlighting, but we keep the
  // full object so the panel can re-render the proposal card without a rescan.
  const snapshot = {
    id: session.id,
    tabId: session.tabId,
    urlAtStart: session.urlAtStart || "",
    proposedAtUrl: session.proposedAtUrl || "",
    goal: session.goal,
    maxSteps: session.maxSteps,
    step: session.step,
    scanGeneration: session.scanGeneration,
    status: session.status,
    pendingAction: session.pendingAction ?? null,
    dryRun: Boolean(session.dryRun),
    log: Array.isArray(session.log) ? session.log : [],
    message: session.message || "",
    updatedAt: session.updatedAt ?? Date.now()
  };

  const payload = { [SESSION_KEY]: snapshot };

  // Write to session storage first (fastest); fall back silently.
  const writeSession = chrome.storage.session
    ? chrome.storage.session.set(payload).catch(() => {})
    : Promise.resolve();

  // Also mirror to local storage so the session survives a full browser restart.
  const writeLocal = chrome.storage.local
    .set({ [SESSION_KEY]: snapshot })
    .catch(() => {});

  await Promise.all([writeSession, writeLocal]);
}

/**
 * Reads the most recent session snapshot.
 * Prefers session storage (most up-to-date after a SW wake-up);
 * falls back to local storage if session storage returns nothing.
 *
 * @returns {Promise<object|null>} The stored snapshot, or null if none.
 */
export async function loadSession() {
  // Try session storage first.
  if (chrome.storage.session) {
    try {
      const stored = await chrome.storage.session.get(SESSION_KEY);
      const snap = stored?.[SESSION_KEY];
      if (snap && typeof snap === "object" && snap.id) return snap;
    } catch {
      // Session storage unavailable; fall through to local.
    }
  }

  // Fall back to local storage.
  try {
    const stored = await chrome.storage.local.get(SESSION_KEY);
    const snap = stored?.[SESSION_KEY];
    if (snap && typeof snap === "object" && snap.id) return snap;
  } catch {
    // Nothing recoverable.
  }

  return null;
}

/**
 * Erases the session checkpoint from both storage areas.
 * Called when a session reaches a terminal state (done / stopped / blocked).
 *
 * @returns {Promise<void>}
 */
export async function clearSession() {
  const clear1 = chrome.storage.session
    ? chrome.storage.session.remove(SESSION_KEY).catch(() => {})
    : Promise.resolve();
  const clear2 = chrome.storage.local.remove(SESSION_KEY).catch(() => {});
  await Promise.all([clear1, clear2]);
}
