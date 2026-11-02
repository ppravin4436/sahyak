import { handleMessage } from "./messages.js";
import { handleChatPort } from "./chat.js";
import { registerContextMenus, handleContextMenuClick } from "./context-menu.js";
import { restoreAgentSession } from "./agent/loop.js";

const CHAT_PORT_NAME = "sahayak-chat";

/**
 * Slice 3.4: On every SW wake, restore any in-progress agent session from
 * storage and notify any open side panel so it can re-show the proposal.
 *
 * This is called from each event listener entry point so the SW picks up the
 * session no matter what woke it (message, tab update, alarm, etc.).
 *
 * Rules:
 *  - Never auto-execute: restoreAgentSession() only rehydrates memory.
 *  - Only broadcast when there is actually an active session to show.
 *  - Errors are silent — a failed restore just means the panel shows idle state.
 */
async function tryRestoreAndBroadcast() {
  try {
    const result = await restoreAgentSession();
    // Only push if the session is active (idle or awaiting_approval).
    if (result?.data?.active || result?.data?.status === "awaiting_approval") {
      chrome.runtime.sendMessage({ type: "AGENT_STATE_PUSH", data: result.data }).catch(() => {
        // Panel may not be open yet — that's fine; it will call AGENT_STATE on open.
      });
    }
  } catch {
    // Non-fatal: panel falls back to polling AGENT_STATE on open.
  }
}

// Edge case 2.2-05: refresh the menu on both install and browser start.
chrome.runtime.onInstalled.addListener(() => {
  registerContextMenus().catch((err) =>
    console.error("Sahayak failed to register context menus.", err?.message || err)
  );
  tryRestoreAndBroadcast();
});

chrome.runtime.onStartup.addListener(() => {
  registerContextMenus().catch((err) =>
    console.error("Sahayak failed to register context menus.", err?.message || err)
  );
  tryRestoreAndBroadcast();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  tryRestoreAndBroadcast();
  handleContextMenuClick(info, tab).catch((error) => {
    console.error("Sahayak context action failed.", error?.message || error);
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  tryRestoreAndBroadcast();
  try {
    const windowId = tab.windowId ?? (await chrome.windows.getCurrent()).id;
    await chrome.sidePanel.open({ windowId });
  } catch (error) {
    console.error("Sahayak could not open the side panel.", error?.message || error);
  }
});

chrome.runtime.onConnect.addListener((port) => {
  tryRestoreAndBroadcast();
  if (port.name === CHAT_PORT_NAME) {
    handleChatPort(port);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Restore session on every incoming message (covers panel open after SW sleep).
  tryRestoreAndBroadcast();

  handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || "Unexpected error"
      });
    });
  return true;
});
