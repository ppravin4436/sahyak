/**
 * One-step approval agent loop (Slice 3.3 / 3.4 / 4.3).
 *
 * Perceive → propose → wait → execute → loop. The model proposes exactly one
 * action per turn and nothing touches the page until the user approves it.
 *
 * Slice 3.4: session checkpointed before every user-wait; restored on SW wake;
 *   never auto-executed.
 * Slice 4.3: startAgent now accepts user-owned origins (getOwnedOrigins) in
 *   addition to bundled practice pages. isSensitiveNode / isConsequentialNode
 *   from the new safety modules re-validate every proposal before it is shown.
 */

import { callAiTask } from "../ai/router.js";
import { buildAgentStepPrompt, buildAgentStepRepairPrompt } from "../ai/prompts.js";
import { buildActionMap, validateAgentAction } from "./schemas.js";
import { canSendToModel, isPracticeOrigin, getOwnedOrigins, isOwnedOrigin } from "../safety/urls.js";
import { isSensitiveNode } from "../safety/fields.js";
import { isConsequentialNode } from "../safety/consequential.js";
import { persistSession, loadSession, clearSession } from "./session.js";
import { getProfile, buildProfileSnippet, matchProfileValue } from "../profile.js";
import {
  MESSAGE_VERSION,
  resolveTab,
  isHttpUrl,
  getSettings,
  requestScanFromTab,
  highlightElement
} from "../messages.js";

const DEFAULT_MAX_STEPS = 20;
const MIN_MAX_STEPS = 1;
const MAX_MAX_STEPS = 50;
const TERMINAL_STATUSES = new Set(["done", "stopped", "blocked"]);

/** In-memory session — the single source of truth while the SW is alive.
 *  Storage (session.js) is the checkpoint that survives SW sleep. */
let session = null;

/* ------------------------------------------------------------------ state */

function publicState() {
  if (!session) {
    return {
      active: false,
      status: "idle",
      tabId: null,
      goal: "",
      step: 0,
      maxSteps: DEFAULT_MAX_STEPS,
      pendingAction: null,
      log: [],
      message: "",
      dryRun: false
    };
  }

  return {
    active: !TERMINAL_STATUSES.has(session.status),
    status: session.status,
    tabId: session.tabId,
    goal: session.goal,
    step: session.step,
    maxSteps: session.maxSteps,
    pendingAction: session.pendingAction,
    log: session.log,
    message: session.message,
    dryRun: session.dryRun
  };
}

/** The panel's view of the current session. */
export function getAgentState() {
  return publicState();
}

function agentError(code, error) {
  if (session) {
    session.status = "blocked";
    session.pendingAction = null;
    session.message = error;
    session.updatedAt = Date.now();
    // Blocked is terminal — erase the checkpoint.
    clearSession().catch(() => {});
  }
  return { ok: false, code, error, data: publicState() };
}

/* ------------------------------------------------------------------ helpers */

function nodeLabel(node) {
  if (!node) return "the target element";
  return `#${node.n} ${node.text || `(${node.tag})`}`;
}

function describeAction(action, node) {
  switch (action.type) {
    case "click":
      return `Click ${nodeLabel(node)}`;
    case "type":
      return `Type "${action.value}" into ${nodeLabel(node)}`;
    case "select":
      return `Choose "${action.value}" in ${nodeLabel(node)}`;
    case "scroll":
      return action.n ? `Scroll to ${nodeLabel(node)}` : `Scroll ${action.direction}`;
    case "done":
      return "Finish";
    default:
      return action.type;
  }
}

function logEntry(action, decision) {
  if (!session) return;
  session.log.push({
    step: session.step + 1,
    proposed: {
      type: action.type,
      n: action.n,
      value: action.value,
      direction: action.direction,
      reason: action.reason
    },
    // Valid decisions: "approved" | "skipped" | "stopped" | "blocked" | "dry-run"
    decision,
    at: new Date().toISOString()
  });
}

/** Short digest of recently skipped steps so the model does not repeat them (3.3-13). */
function buildDigest(log) {
  return log
    .filter((entry) => entry.decision === "skipped")
    .slice(-5)
    .map((entry) => `${entry.proposed.type} #${entry.proposed.n ?? "-"}`)
    .join(", ");
}

/** Origin + path only: tolerates in-page hash changes, catches real navigations (3.3-06). */
function sameTargetUrl(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return false;
  }
}

async function clearOverlay(tabId) {
  if (typeof tabId !== "number") return;
  try {
    await chrome.tabs.sendMessage(tabId, { v: MESSAGE_VERSION, type: "CLEAR_OVERLAY" });
  } catch {
    // Nothing injected means nothing to clear.
  }
}

async function executeAction(tab, action, scanGeneration) {
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      v: MESSAGE_VERSION,
      type: "EXECUTE_ACTION",
      payload: { action, scanGeneration }
    });
    if (response?.ok) return { ok: true, data: response.data };
    return {
      ok: false,
      code: response?.code || "EXECUTE_FAILED",
      error: response?.error || "The action failed."
    };
  } catch (err) {
    return {
      ok: false,
      code: "EXECUTE_FAILED",
      error: err?.message || "Could not reach the page."
    };
  }
}

/* ------------------------------------------------------------------ loop */

async function finish(status, message) {
  if (session) {
    session.status = status;
    session.pendingAction = null;
    session.message = message || "";
    session.updatedAt = Date.now();
    await clearOverlay(session.tabId);
    // Terminal state — erase the checkpoint so a dead session is never restored.
    await clearSession();
  }
  return { ok: true, data: publicState() };
}

/**
 * Perceives the page and asks the model for exactly one next action. The action
 * is never run here — it is stored as `pendingAction` and highlighted for review.
 */
async function proposeNext(tab) {
  if (!session) return agentError("NO_SESSION", "No agent session is running.");

  if (session.step >= session.maxSteps) {
    return finish("done", `Reached the step limit (${session.maxSteps}).`);
  }

  const scanned = await requestScanFromTab(tab);
  if (!scanned.ok) return agentError(scanned.code, scanned.error);

  const scan = scanned.data;
  session.scanGeneration = scan.scanGeneration;

  if (!Array.isArray(scan.nodes) || scan.nodes.length === 0) {
    return agentError("NO_ELEMENTS", "Sahayak found no interactive elements on this page.");
  }

  const actionMap = buildActionMap(scan);
  const settings = await getSettings();
  const step = session.step + 1;
  const digest = buildDigest(session.log);

  // Slice 4.1: inject compact profile into the prompt so the model can suggest
  // profile values (e.g. user's name for a "Full name" field).
  const profile = await getProfile();
  const profileSnippet = buildProfileSnippet(profile);

  const call = (prompt) =>
    callAiTask({
      task: "agent",
      args: { prompt, temperature: 0.2, maxTokens: 300 },
      settings
    });

  let result = await call(buildAgentStepPrompt({ goal: session.goal, actionMap, step, digest, profileSnippet }));
  if (!result.ok) return agentError(result.code || "AI_FAILED", result.error);

  let validation = validateAgentAction(result.text, { nodeCount: scan.nodes.length });

  if (!validation.ok) {
    const repaired = await call(
      buildAgentStepRepairPrompt({
        goal: session.goal,
        actionMap,
        previous: result.text,
        error: validation.error,
        step,
        profileSnippet
      })
    );
    if (!repaired.ok) return agentError(repaired.code || "AI_FAILED", repaired.error);

    validation = validateAgentAction(repaired.text, { nodeCount: scan.nodes.length });
    if (!validation.ok) {
      return agentError("BAD_ACTION", "Sahayak could not work out a valid next step. Try rephrasing the goal.");
    }
  }

  const action = validation.data;

  if (action.type === "done") {
    return finish("done", action.reason);
  }

  const node = action.n ? scan.nodes.find((item) => item.n === action.n) || null : null;

  // Highlight the target so the user can see exactly what they are approving.
  if (node) {
    await highlightElement(tab, action.n, scan.scanGeneration);
  }

  // Slice 4.1: detect whether the proposed value came from the user's profile.
  // This is shown on the proposal card so the user knows exactly what will be typed.
  // Rule: only non-sensitive fields; the user still Approves before anything happens.
  let profileSource = null;
  if (action.type === "type" && node && !node.sensitive && profileSnippet) {
    const match = matchProfileValue(node, profile);
    if (match && match.value === action.value) {
      profileSource = match.field; // e.g. "name", "college"
    }
  }

  // Slice 4.3: re-validate sensitivity and consequential flags using the
  // definitive safety modules — scanner heuristics are a best-effort first pass,
  // but the SW-side isSensitiveNode / isConsequentialNode are the authoritative
  // gate before any proposal reaches the user.
  const sensitiveByModule   = node ? isSensitiveNode(node)     : false;
  const consequentialByModule = node ? isConsequentialNode(node) : false;

  session.pendingAction = {
    ...action,
    node,
    sentence: describeAction(action, node),
    sensitive:     Boolean(node?.sensitive)     || sensitiveByModule,
    consequential: Boolean(node?.consequential) || consequentialByModule,
    profileSource: profileSource ?? null
  };
  session.proposedAtUrl = scan.url || tab.url || "";
  session.status = "awaiting_approval";
  session.message = "";
  session.updatedAt = Date.now();

  // Slice 3.4: checkpoint before returning so the proposal survives SW sleep.
  // The user may not tap Approve for seconds or minutes; the SW will be dead by then.
  await persistSession(session);

  return { ok: true, data: publicState() };
}

/* --------------------------------------------------------------- commands */

/** Starts a session and proposes the first step. Nothing runs yet. */
export async function startAgent({ tabId, windowId, payload } = {}) {
  const goal = String(payload?.goal || "").trim();
  if (!goal) {
    return { ok: false, code: "NO_GOAL", error: "Tell Sahayak what you want it to do." };
  }

  const tab = await resolveTab({ tabId, windowId });
  if (!tab) {
    return { ok: false, code: "NO_TAB", error: "No active browser tab found." };
  }

  // Slice 4.3: practice pages (bundled) and user-declared owned origins are both allowed.
  // All other http/https pages that pass canSendToModel get the NOT_PRACTICE_PAGE block
  // until the user marks the origin as owned.
  const tabUrl = tab.url || "";
  const ownedOrigins = await getOwnedOrigins();

  if (isPracticeOrigin(tabUrl)) {
    // Bundled practice page — skip safety checks entirely (local resources).
  } else if (isOwnedOrigin(tabUrl, ownedOrigins)) {
    // User-declared "I own this page" — still apply canSendToModel to catch
    // payment/banking paths the user may not have noticed.
    if (!isHttpUrl(tabUrl)) {
      return {
        ok: false,
        code: "UNSUPPORTED_PAGE",
        error: "Sahayak can only act on normal webpages (http/https)."
      };
    }
    const safety = canSendToModel(tabUrl);
    if (!safety.ok) {
      return {
        ok: false,
        code: "BLOCKED_URL",
        error: safety.reason || "This page is blocked even for owned origins."
      };
    }
    // Owned origin passes — fall through to session setup.
  } else {
    if (!isHttpUrl(tabUrl)) {
      return {
        ok: false,
        code: "UNSUPPORTED_PAGE",
        error: "Sahayak can only act on normal webpages (http/https)."
      };
    }

    const safety = canSendToModel(tabUrl);
    if (!safety.ok) {
      return {
        ok: false,
        code: "BLOCKED_URL",
        error: safety.reason || "This page is blocked for safety reasons."
      };
    }

    // Not a practice page and not owned — prompt the user to declare ownership.
    return {
      ok: false,
      code: "NOT_PRACTICE_PAGE",
      error:
        "The agent can only run on practice pages or pages you have marked as owned. " +
        "Use the \"I own this page\" button on the Agent tab to unlock this origin."
    };
  }

  // Read maxSteps and dryRunDefault from persisted settings.
  const settings = await getSettings();
  const savedMaxSteps = parseInt(settings?.maxSteps, 10);
  const maxSteps = Number.isFinite(savedMaxSteps) &&
    savedMaxSteps >= MIN_MAX_STEPS &&
    savedMaxSteps <= MAX_MAX_STEPS
    ? savedMaxSteps
    : DEFAULT_MAX_STEPS;

  // Payload can explicitly override the default (e.g. panel toggle beats settings).
  const dryRun = typeof payload?.dryRun === "boolean"
    ? payload.dryRun
    : Boolean(settings?.dryRunDefault);

  session = {
    id: crypto.randomUUID(),
    tabId: tab.id,
    urlAtStart: tabUrl,
    proposedAtUrl: tabUrl,
    goal,
    maxSteps,
    step: 0,
    scanGeneration: 0,
    status: "idle",
    pendingAction: null,
    dryRun,
    log: [],
    message: "",
    updatedAt: Date.now()
  };

  return proposeNext(tab);
}

/** Executes exactly the pending action, then proposes the next one. */
export async function approveStep() {
  if (!session) return agentError("NO_SESSION", "No agent session is running.");
  if (session.status !== "awaiting_approval" || !session.pendingAction) {
    return { ok: true, data: publicState() };
  }

  const action = session.pendingAction;

  // Edge case 3.3-15: flip status before any await so a double-click cannot run twice.
  session.status = "executing";
  session.pendingAction = null;

  const tab = await resolveTab({ tabId: session.tabId });
  if (!tab) {
    logEntry(action, "blocked");
    return finish("stopped", "The tab was closed.");
  }

  // Edge case 3.3-06: never execute on a surprise URL.
  if (!sameTargetUrl(tab.url || "", session.proposedAtUrl)) {
    logEntry(action, "blocked");
    return finish("blocked", "The page navigated somewhere unexpected. Sahayak stopped.");
  }

  // Edge cases 3.3-03, 3.3-04: never type into a sensitive field, even if approved.
  if (action.type === "type" && action.sensitive) {
    logEntry(action, "blocked");
    return agentError("SENSITIVE_BLOCKED", "Sahayak refused to type into a password, OTP, or card field.");
  }

  // ── DRY-RUN PATH ─────────────────────────────────────────────────────────────
  // Approve only re-highlights the element; nothing is written to the DOM.
  if (session.dryRun) {
    if (action.n) {
      await highlightElement(tab, action.n, session.scanGeneration).catch(() => {});
    }
    logEntry(action, "dry-run");
    session.step += 1;

    if (action.type === "done") {
      return finish("done", action.reason);
    }

    const dryTab = await resolveTab({ tabId: session.tabId });
    if (!dryTab) return finish("stopped", "The tab was closed.");

    session.status = "idle";
    return proposeNext(dryTab);
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const result = await executeAction(tab, action, session.scanGeneration);

  if (!result.ok) {
    logEntry(action, "blocked");

    // Edge case 3.3-05: rescan and re-propose instead of retrying a stale index.
    if (result.code === "STALE_SCAN" || result.code === "NODE_GONE") {
      const freshTab = await resolveTab({ tabId: session.tabId });
      if (!freshTab) return finish("stopped", "The tab was closed.");
      session.status = "idle";
      return proposeNext(freshTab);
    }

    return agentError(result.code, result.error);
  }

  logEntry(action, "approved");
  session.step += 1;

  if (action.type === "done") {
    return finish("done", action.reason);
  }

  const freshTab = await resolveTab({ tabId: session.tabId });
  if (!freshTab) return finish("stopped", "The tab was closed.");

  session.status = "idle";
  return proposeNext(freshTab);
}

/** Skips the pending action and asks the model for a different one (3.3-13). */
export async function skipStep() {
  if (!session) return agentError("NO_SESSION", "No agent session is running.");
  if (session.status !== "awaiting_approval" || !session.pendingAction) {
    return { ok: true, data: publicState() };
  }

  logEntry(session.pendingAction, "skipped");
  session.pendingAction = null;
  session.step += 1;

  const tab = await resolveTab({ tabId: session.tabId });
  if (!tab) return finish("stopped", "The tab was closed.");

  session.status = "idle";
  return proposeNext(tab);
}

/** Ends the session and clears the badges. */
export async function stopAgent({ tabId } = {}) {
  if (!session) return { ok: true, data: publicState() };

  const targetId = typeof tabId === "number" ? tabId : session.tabId;
  if (session.pendingAction) {
    logEntry(session.pendingAction, "stopped");
  }

  session.tabId = typeof targetId === "number" ? targetId : session.tabId;
  return finish("stopped", "Stopped.");
}

/**
 * Slice 3.4 — Rehydrates the in-memory session from storage after a SW wake.
 *
 * Rules (architecture §8.6):
 *  - Never auto-execute a pending action. Status stays "awaiting_approval".
 *  - If the stored session is terminal, return idle state (don't restore it).
 *  - If the tab is gone, mark stopped and clear.
 *
 * Called by sw.js on every SW wake so the panel can rebind to a live session.
 *
 * @returns {Promise<{ ok: boolean, data: object }>}
 */
export async function restoreAgentSession() {
  // If an in-memory session already exists (SW never slept), nothing to do.
  if (session) return { ok: true, data: publicState() };

  const snap = await loadSession();
  if (!snap || typeof snap !== "object" || !snap.id) {
    return { ok: true, data: publicState() }; // nothing stored
  }

  const TERMINAL = new Set(["done", "stopped", "blocked"]);
  if (TERMINAL.has(snap.status)) {
    // Stale terminal checkpoint — clean it up and return idle.
    await clearSession();
    return { ok: true, data: publicState() };
  }

  // Rehydrate. A restored awaiting_approval session MUST NOT be auto-executed.
  session = {
    id: snap.id,
    tabId: snap.tabId,
    urlAtStart: snap.urlAtStart || "",
    proposedAtUrl: snap.proposedAtUrl || "",
    goal: snap.goal || "",
    maxSteps: typeof snap.maxSteps === "number" ? snap.maxSteps : DEFAULT_MAX_STEPS,
    step: typeof snap.step === "number" ? snap.step : 0,
    scanGeneration: typeof snap.scanGeneration === "number" ? snap.scanGeneration : 0,
    // Force status back to awaiting_approval so the panel shows the proposal.
    status: snap.status === "awaiting_approval" ? "awaiting_approval" : snap.status,
    pendingAction: snap.pendingAction ?? null,
    dryRun: Boolean(snap.dryRun),
    log: Array.isArray(snap.log) ? snap.log : [],
    message: snap.message || "",
    updatedAt: snap.updatedAt ?? Date.now()
  };

  return { ok: true, data: publicState() };
}
