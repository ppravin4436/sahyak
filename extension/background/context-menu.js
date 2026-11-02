/**
 * Right-click context-menu actions (Slice 2.2).
 * Registers the Explain / Translate / Draft items, opens the side panel, and
 * hands the current selection to the panel through a short-lived record in
 * chrome.storage.session so it works even when the panel was closed.
 */

const PENDING_KEY = "context.pending";
// Ignore a parked action if the panel never came up in reasonable time.
const PENDING_TTL_MS = 60_000;

/** id suffix -> menu label. Order here is the order shown in the menu. */
export const CONTEXT_ACTIONS = {
  explain: "Explain selection",
  translate: "Translate selection",
  draft: "Draft a reply"
};

/** Removes any previously registered items, then creates the three actions fresh. */
export async function registerContextMenus() {
  // Edge case 2.2-05: drop stale items after an extension update before re-creating.
  await chrome.contextMenus.removeAll();

  for (const [id, title] of Object.entries(CONTEXT_ACTIONS)) {
    chrome.contextMenus.create(
      {
        id: `sahayak_${id}`,
        title,
        // Edge case 2.2-01: only offered when text is selected.
        contexts: ["selection"]
      },
      // Suppress "duplicate id" errors that can fire during rapid service-worker restarts.
      () => void chrome.runtime.lastError
    );
  }
}

/**
 * Handles a context-menu click: parks the selection, opens the side panel,
 * then nudges any already-open panel to pick it up.
 * @param {chrome.contextMenus.OnClickData} info
 * @param {chrome.tabs.Tab} [tab]
 */
export async function handleContextMenuClick(info, tab) {
  const action = String(info?.menuItemId || "").replace(/^sahayak_/, "");
  if (!(action in CONTEXT_ACTIONS)) return;

  const record = {
    action,
    // Edge case 2.2-04: contenteditable/iframe selections may not be readable.
    selectionText: (info?.selectionText || "").trim(),
    title: tab?.title || "Current webpage",
    url: info?.pageUrl || tab?.url || "",
    tabId: tab?.id ?? null,
    windowId: tab?.windowId ?? null,
    at: Date.now()
  };

  try {
    await chrome.storage.session.set({ [PENDING_KEY]: record });
  } catch {
    // Session storage unavailable; the panel can still run a fresh selection.
  }

  // Edge case 2.2-02: open the panel first, then let it consume the record.
  try {
    const windowId = record.windowId ?? (await chrome.windows.getCurrent()).id;
    await chrome.sidePanel.open({ windowId });
  } catch {
    // Panel may already be open; the panel still consumes the record on load.
  }

  // Nudge an already-open panel to consume immediately.
  chrome.runtime.sendMessage({ type: "CONTEXT_ACTION_PENDING" }).catch(() => {});
}

/**
 * Reads and clears the parked action. Returns null when there is nothing
 * pending or when the record is older than the TTL.
 * @returns {Promise<object|null>}
 */
export async function takePendingAction() {
  try {
    const stored = await chrome.storage.session.get(PENDING_KEY);
    const record = stored?.[PENDING_KEY];
    if (!record || typeof record !== "object") return null;

    await chrome.storage.session.remove(PENDING_KEY);

    if (Date.now() - (record.at || 0) > PENDING_TTL_MS) return null;
    return record;
  } catch {
    return null;
  }
}
