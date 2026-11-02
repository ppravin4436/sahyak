import { parseTimestampToSeconds } from "../background/youtube.js";

const MESSAGE_VERSION = 1;

/** State tracking */
let currentTabId = null;
let lastTabInfo = null;
let lastExplanationData = null;
let lastSummaryData = null;
let isGenerating = false;
let pendingLanguageChange = null;
let lastGenerationType = null;

/** Slice 4.1 — cached profile from the last bootstrap call */
let currentProfile = {};

/** Slice 4.2 — cached skills list from the last bootstrap call */
let currentSkills = [];

/** Slice 4.3 — cached owned origins list from the last bootstrap call */
let currentOwnedOrigins = [];

/* Grounded page chat state (Slice 2.1) */
const CHAT_PORT_NAME = "sahayak-chat";
let hasGeminiKey = false;
let chatPort = null;
let chatTurns = [];
let chatBusy = false;
let activeChatRequestId = null;
let inflightTurn = null; // { userBubble, assistantWrap, assistantBody, partial, userText }

function envelope(type, payload = {}, tabId = currentTabId) {
  return {
    v: MESSAGE_VERSION,
    type,
    requestId: crypto.randomUUID(),
    tabId,
    payload
  };
}

async function send(type, payload, tabId = currentTabId) {
  return chrome.runtime.sendMessage(envelope(type, payload, tabId));
}

/**
 * Safely format markdown (headings, bold, lists, code, paragraphs).
 * Escapes raw HTML first to prevent any script injection.
 * Supports interactive YouTube timestamps with direct video seeking.
 * @param {string} text
 * @param {object} [options]
 * @param {boolean} [options.isYouTube]
 * @param {string} [options.videoId]
 * @returns {string}
 */
function formatMarkdown(text, options = {}) {
  if (!text) return "";

  const escapeHtml = (str) =>
    str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  function replaceTimestamps(safeStr) {
    if (!options.isYouTube) return safeStr;
    const videoId = options.videoId || "";

    // 1. Match bracketed or parenthesized timestamps: [01:23] or (1:02:30)
    let out = safeStr.replace(/(?:\[|\()(\d{1,2}:\d{2}(?::\d{2})?)(?:\]|\))/g, (_match, stamp) => {
      const sec = parseTimestampToSeconds(stamp);
      if (sec === null) return _match;
      const href = videoId
        ? `https://www.youtube.com/watch?v=${videoId}&amp;t=${sec}s`
        : `#t=${sec}`;
      return `<a href="${href}" class="yt-timestamp-link" data-seconds="${sec}" data-video-id="${videoId}" title="Seek video to ${stamp}"><svg class="timestamp-play-icon" viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><span>${stamp}</span></a>`;
    });

    // 2. Also match leading timestamps in chapter lists e.g. "01:23 -" or "01:23:"
    out = out.replace(/(^|<li>|\s)(\d{1,2}:\d{2}(?::\d{2})?)(?=\s*[-:–—\s])/g, (_match, prefix, stamp) => {
      const sec = parseTimestampToSeconds(stamp);
      if (sec === null) return _match;
      const href = videoId
        ? `https://www.youtube.com/watch?v=${videoId}&amp;t=${sec}s`
        : `#t=${sec}`;
      return `${prefix}<a href="${href}" class="yt-timestamp-link" data-seconds="${sec}" data-video-id="${videoId}" title="Seek video to ${stamp}"><svg class="timestamp-play-icon" viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><span>${stamp}</span></a>`;
    });

    return out;
  }

  function formatInline(str) {
    let safe = escapeHtml(str);
    safe = safe.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
    safe = safe.replace(/(^|[^*])\*(?!\s)([^*]+)(?!\s)\*/g, "$1<em>$2</em>");
    return replaceTimestamps(safe);
  }

  const lines = text.split("\n");
  let html = "";
  let inList = false;
  let listType = ""; // "ul" | "ol"

  function closeList() {
    if (inList) {
      html += listType === "ol" ? "</ol>" : "</ul>";
      inList = false;
      listType = "";
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    // Numbered list: 1. 2. etc
    if (/^\d+\.\s+/.test(trimmed)) {
      if (!inList || listType !== "ol") {
        closeList();
        html += "<ol>";
        inList = true;
        listType = "ol";
      }
      const itemContent = trimmed.replace(/^\d+\.\s+/, "");
      html += `<li>${formatInline(itemContent)}</li>`;
      continue;
    }

    // Unordered bullet list: -, *, or •
    if (/^[-*•]\s+/.test(trimmed)) {
      if (!inList || listType !== "ul") {
        closeList();
        html += "<ul>";
        inList = true;
        listType = "ul";
      }
      const itemContent = trimmed.replace(/^[-*•]\s+/, "");
      html += `<li>${formatInline(itemContent)}</li>`;
      continue;
    }

    closeList();

    // Headings
    if (trimmed.startsWith("### ")) {
      html += `<h3>${formatInline(trimmed.slice(4))}</h3>`;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      html += `<h2>${formatInline(trimmed.slice(3))}</h2>`;
      continue;
    }
    if (trimmed.startsWith("# ")) {
      html += `<h1>${formatInline(trimmed.slice(2))}</h1>`;
      continue;
    }

    html += `<p>${formatInline(trimmed)}</p>`;
  }

  closeList();
  return html;
}

function renderBanners(bootstrap) {
  const host = document.getElementById("banners");
  host.replaceChildren();

  const add = (className, html) => {
    const el = document.createElement("div");
    el.className = `banner ${className}`;
    el.innerHTML = html;
    host.append(el);
  };

  if (!bootstrap?.hasGeminiKey) {
    add(
      "warn",
      `Set API key in Settings before Sahayak can call Gemini. <a href="#" id="banner-settings">Open Settings</a> • <a href="#" id="banner-recheck">Re-check</a>`
    );
  }

  const tab = bootstrap?.tab;
  if (!tab) {
    add("warn", "Open a webpage in this window, then use Sahayak beside it.");
    return;
  }

  if (!tab.supported) {
    add(
      "danger",
      "This tab is an internal page (like chrome:// or Web Store). Open a normal webpage to use Sahayak."
    );
  }
}

function renderPageMeta(tab) {
  const containers = [
    document.getElementById("page-meta-container"),
    document.getElementById("summary-page-meta-container")
  ];

  containers.forEach((container) => {
    if (!container) return;
    container.replaceChildren();

    if (!tab) return;

    const card = document.createElement("div");
    card.className = "page-meta";

    const title = document.createElement("strong");
    title.textContent = tab.title || "Untitled page";

    const url = document.createElement("span");
    url.textContent = tab.url || "";

    card.append(title, url);
    container.append(card);
  });
}

function wireBannerLinks() {
  document.getElementById("banner-settings")?.addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  document.getElementById("banner-recheck")?.addEventListener("click", (event) => {
    event.preventDefault();
    refresh();
  });
}

function showNotice(targetId, text, type = "warn", actionLink = null) {
  const noticeBox = document.getElementById(targetId);
  if (!noticeBox) return;

  noticeBox.hidden = false;
  noticeBox.className = `notice-box ${type}`;
  noticeBox.innerHTML = "";

  const textSpan = document.createElement("span");
  textSpan.textContent = text;
  noticeBox.append(textSpan);

  if (actionLink) {
    const link = document.createElement("a");
    link.href = "#";
    link.style.marginLeft = "8px";
    link.style.fontWeight = "600";
    link.style.color = "inherit";
    link.textContent = actionLink.label;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      actionLink.onClick();
    });
    noticeBox.append(link);
  }
}

function hideNotice(targetId) {
  const noticeBox = document.getElementById(targetId);
  if (!noticeBox) return;
  noticeBox.hidden = true;
  noticeBox.textContent = "";
}

function switchToTab(sectionName) {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach((tab) => {
    const isActive = tab.dataset.section === sectionName;
    tab.classList.toggle("is-active", isActive);
  });
  document.querySelectorAll(".section").forEach((section) => {
    section.classList.toggle("is-active", section.id === `section-${sectionName}`);
  });
  refreshComposer();
}

/* ==========================================================================
   SELECTION EXPLANATION (Slice 1.2)
   ========================================================================== */

function renderExplanation(data) {
  const resultPane = document.getElementById("explain-result-pane");
  const quoteEl = document.getElementById("explain-quote");
  const truncateEl = document.getElementById("explain-truncate-notice");
  const headingBadge = document.getElementById("explain-heading-badge");
  const langBadge = document.getElementById("explain-lang-badge");
  const outputEl = document.getElementById("explain-output");
  const actionsEl = document.getElementById("explain-actions");
  const toggleBtnText = document.getElementById("lang-toggle-btn-text");

  lastExplanationData = data;
  lastGenerationType = "explain";

  quoteEl.textContent = data.selection || "";
  truncateEl.hidden = !data.truncated;

  if (data.heading) {
    headingBadge.hidden = false;
    headingBadge.textContent = data.heading;
    headingBadge.title = `Section: ${data.heading}`;
  } else {
    headingBadge.hidden = true;
  }

  const isHinglish = data.language === "hinglish";
  langBadge.textContent = isHinglish ? "Hinglish" : "English";
  toggleBtnText.textContent = isHinglish ? "Explain in English" : "Explain in Hinglish";

  outputEl.innerHTML = formatMarkdown(data.explanation || "");

  document.getElementById("explain-loading").hidden = true;
  outputEl.hidden = false;
  actionsEl.hidden = false;
  resultPane.hidden = false;
}

async function explainCurrentSelection(overridePayload = null) {
  const btn = document.getElementById("btn-explain-selection");
  const resultPane = document.getElementById("explain-result-pane");
  const loadingEl = document.getElementById("explain-loading");
  const outputEl = document.getElementById("explain-output");
  const actionsEl = document.getElementById("explain-actions");
  const langSelect = document.getElementById("language");

  hideNotice("explain-notice");
  btn.disabled = true;
  isGenerating = true;

  const targetLang = overridePayload?.language || langSelect.value || "en";

  resultPane.hidden = false;
  loadingEl.hidden = false;
  outputEl.hidden = true;
  actionsEl.hidden = true;

  if (overridePayload?.selection) {
    document.getElementById("explain-quote").textContent = overridePayload.selection;
  }

  try {
    const payload = overridePayload ? { ...overridePayload, language: targetLang } : { language: targetLang };
    const result = await send("EXPLAIN_SELECTION", payload, currentTabId);

    if (!result?.ok) {
      loadingEl.hidden = true;
      if (!lastExplanationData) {
        resultPane.hidden = true;
      } else {
        outputEl.hidden = false;
        actionsEl.hidden = false;
      }

      if (result?.code === "NO_SELECTION") {
        showNotice(
          "explain-notice",
          "Please highlight some text on the webpage first, then click Explain selection.",
          "warn"
        );
      } else if (result?.code === "MISSING_KEY" || result?.code === "NO_KEY") {
        showNotice("explain-notice", "Set your Gemini API key in Settings before Sahayak can explain text.", "warn", {
          label: "Open Settings",
          onClick: () => chrome.runtime.openOptionsPage()
        });
      } else if (result?.code === "INVALID_KEY") {
        showNotice("explain-notice", "Invalid Gemini API key. Please check your API key in Settings.", "danger", {
          label: "Open Settings",
          onClick: () => chrome.runtime.openOptionsPage()
        });
      } else if (result?.code === "SENSITIVE_FIELD") {
        showNotice(
          "explain-notice",
          "The selected text is from a password or credential field and cannot be sent to the model for security.",
          "danger"
        );
      } else {
        showNotice("explain-notice", result?.error || "Could not explain selection.", "danger");
      }
      return;
    }

    renderExplanation(result.data);
  } catch (error) {
    loadingEl.hidden = true;
    if (!lastExplanationData) {
      resultPane.hidden = true;
    }
    showNotice("explain-notice", error?.message || "Failed to communicate with Sahayak service worker.", "danger");
  } finally {
    btn.disabled = false;
    isGenerating = false;
    if (pendingLanguageChange) {
      const nextLang = pendingLanguageChange;
      pendingLanguageChange = null;
      if (lastExplanationData?.selection) {
        explainCurrentSelection({ ...lastExplanationData, language: nextLang });
      }
    }
  }
}

/* ==========================================================================
   ARTICLE SUMMARISATION (Slice 1.3)
   ========================================================================== */

function renderSummary(data) {
  const resultPane = document.getElementById("summary-result-pane");
  const titleEl = document.getElementById("summary-article-title");
  const metaEl = document.getElementById("summary-article-meta");
  const langBadge = document.getElementById("summary-lang-badge");
  const truncateBadge = document.getElementById("summary-truncate-badge");
  const outputEl = document.getElementById("summary-output");
  const actionsEl = document.getElementById("summary-actions");
  const toggleBtnText = document.getElementById("lang-toggle-summary-btn-text");

  lastSummaryData = data;
  lastGenerationType = "summary";

  titleEl.textContent = data.title || (data.isYouTube ? "YouTube Video" : "Article Summary");
  const metaParts = [];
  if (data.isYouTube) {
    metaParts.push("YouTube Video");
    if (data.model) metaParts.push(data.model);
  } else {
    if (data.byline) metaParts.push(`By ${data.byline}`);
    if (data.siteName) metaParts.push(data.siteName);
    if (data.charCount) metaParts.push(`~${Math.round(data.charCount / 5)} words read`);
  }
  metaEl.textContent = metaParts.join(" • ");

  const isHinglish = data.language === "hinglish";
  langBadge.textContent = isHinglish ? "Hinglish" : "English";
  toggleBtnText.textContent = isHinglish ? "Summarise in English" : "Summarise in Hinglish";

  truncateBadge.hidden = !data.isTruncated && !data.isYouTube;
  if (data.isYouTube) {
    truncateBadge.hidden = false;
    truncateBadge.textContent = "Interactive Timestamps";
    truncateBadge.className = "badge badge-accent";
  } else if (data.isTruncated) {
    truncateBadge.hidden = false;
    truncateBadge.textContent = "Long article (first section summarized)";
    truncateBadge.className = "badge badge-outline";
  }

  outputEl.innerHTML = formatMarkdown(data.summary || "", {
    isYouTube: Boolean(data.isYouTube),
    videoId: data.videoId,
    canonicalUrl: data.canonicalUrl || data.url
  });

  document.getElementById("summary-loading").hidden = true;
  outputEl.hidden = false;
  actionsEl.hidden = false;
  resultPane.hidden = false;
}

async function summariseCurrentPage(overridePayload = null) {
  const btn = document.getElementById("btn-summarise-page");
  const resultPane = document.getElementById("summary-result-pane");
  const loadingEl = document.getElementById("summary-loading");
  const outputEl = document.getElementById("summary-output");
  const actionsEl = document.getElementById("summary-actions");
  const langSelect = document.getElementById("language");

  hideNotice("summary-notice");
  btn.disabled = true;
  isGenerating = true;

  const targetLang = overridePayload?.language || langSelect.value || "en";

  resultPane.hidden = false;
  loadingEl.hidden = false;
  outputEl.hidden = true;
  actionsEl.hidden = true;

  const loadingText = document.querySelector("#summary-loading .loading-text");
  if (loadingText) {
    loadingText.textContent = lastTabInfo?.isYouTubeVideo
      ? "Analyzing video with Gemini AI & creating chapter notes…"
      : "Extracting article with Readability & generating summary…";
  }

  try {
    const payload = overridePayload ? { ...overridePayload, language: targetLang } : { language: targetLang };
    const result = await send("SUMMARISE_PAGE", payload, currentTabId);

    if (!result?.ok) {
      loadingEl.hidden = true;
      if (!lastSummaryData) {
        resultPane.hidden = true;
      } else {
        outputEl.hidden = false;
        actionsEl.hidden = false;
      }

      if (result?.code === "YOUTUBE_NOT_A_VIDEO") {
        showNotice(
          "summary-notice",
          result?.error || "This is a YouTube navigation page (channel, search, or playlist). Open a specific video to summarize it.",
          "warn"
        );
      } else if (result?.code === "VIDEO_UNAVAILABLE") {
        showNotice(
          "summary-notice",
          result?.error || "This YouTube video is private, age-restricted, or unavailable for AI processing. Sahayak only supports accessible public YouTube videos.",
          "danger"
        );
      } else if (result?.code === "EMPTY_EXTRACTION") {
        showNotice(
          "summary-notice",
          "Couldn’t extract an article from this page. Try highlighting text to explain instead.",
          "warn",
          {
            label: "Switch to Selection →",
            onClick: () => switchToTab("chat")
          }
        );
      } else if (result?.code === "PDF_UNSUPPORTED") {
        showNotice(
          "summary-notice",
          "PDF documents cannot be summarized with Readability. Highlight text on a webpage to explain instead.",
          "warn",
          {
            label: "Switch to Selection →",
            onClick: () => switchToTab("chat")
          }
        );
      } else if (result?.code === "SAFETY_BLOCK") {
        showNotice("summary-notice", result?.error || "This page is blocked for security/privacy.", "danger");
      } else if (result?.code === "MISSING_KEY" || result?.code === "NO_KEY") {
        showNotice("summary-notice", "Set your Gemini API key in Settings before Sahayak can summarize pages.", "warn", {
          label: "Open Settings",
          onClick: () => chrome.runtime.openOptionsPage()
        });
      } else if (result?.code === "INVALID_KEY") {
        showNotice("summary-notice", "Invalid Gemini API key. Please check your API key in Settings.", "danger", {
          label: "Open Settings",
          onClick: () => chrome.runtime.openOptionsPage()
        });
      } else {
        showNotice("summary-notice", result?.error || "Could not generate summary.", "danger");
      }
      return;
    }

    renderSummary(result.data);
  } catch (error) {
    loadingEl.hidden = true;
    if (!lastSummaryData) {
      resultPane.hidden = true;
    }
    showNotice("summary-notice", error?.message || "Failed to communicate with service worker.", "danger");
  } finally {
    btn.disabled = false;
    isGenerating = false;
    if (pendingLanguageChange) {
      const nextLang = pendingLanguageChange;
      pendingLanguageChange = null;
      if (lastSummaryData) {
        summariseCurrentPage({ ...lastSummaryData, language: nextLang });
      }
    }
  }
}

/* ==========================================================================
   GROUNDED PAGE CHAT (Slice 2.1)
   ========================================================================== */

/**
 * Lazily connects the long-lived chat port to the service worker.
 * Streaming CHAT_DELTA chunks arrive here; the port reconnects after the
 * MV3 service worker idles out.
 */
function getChatPort() {
  if (chatPort) return chatPort;

  const port = chrome.runtime.connect({ name: CHAT_PORT_NAME });
  port.onMessage.addListener(handleChatMessage);
  port.onDisconnect.addListener(() => {
    chatPort = null;
    // Edge case 2.1-06: the worker/port dropped mid-turn — settle the UI.
    if (chatBusy) {
      finishChatTurn({ ok: false, code: "DISCONNECTED", error: "Chat connection closed. Please try again." });
    }
  });

  chatPort = port;
  return chatPort;
}

function handleChatMessage(message) {
  if (!message || typeof message !== "object") return;
  // Stale chunks from an aborted turn are ignored.
  if (message.requestId && message.requestId !== activeChatRequestId) return;

  if (message.type === "CHAT_CONTEXT") {
    // Edge case 2.1-03: page changed mid-session — reset and label the change.
    if (message.contextChanged) {
      chatTurns = [];
      clearThreadExceptInflight();
      appendSystemNote(`Page changed — starting a fresh conversation about “${message.pageTitle || "this page"}”.`, null, true);
    }
    return;
  }

  if (message.type === "CHAT_DELTA") {
    if (!inflightTurn) return;
    inflightTurn.partial += message.delta || "";
    inflightTurn.assistantBody.classList.remove("is-streaming");
    inflightTurn.assistantBody.innerHTML = formatMarkdown(inflightTurn.partial);
    scrollThreadToBottom();
    return;
  }

  if (message.type === "CHAT_DONE") {
    finishChatTurn(message);
  }
}

function renderThread() {
  const host = document.getElementById("thread");
  if (!host) return;

  host.replaceChildren();
  inflightTurn = null;

  if (!chatTurns.length) {
    const empty = document.createElement("p");
    empty.className = "thread-empty";
    empty.textContent = "Ask anything about this page. Sahayak answers only from this page's content.";
    host.append(empty);
    return;
  }

  chatTurns.forEach((turn) => {
    appendBubble(turn.role === "user" ? "user" : "assistant", turn.text || "");
  });
  scrollThreadToBottom();
}

function createBubble(role) {
  const host = document.getElementById("thread");
  if (!host) return null;

  host.querySelector(".thread-empty")?.remove();

  const wrap = document.createElement("div");
  wrap.className = `msg msg-${role}`;

  const body = document.createElement("div");
  body.className = "msg-body";
  wrap.append(body);
  host.append(wrap);

  return { wrap, body };
}

function appendBubble(role, text) {
  const bubble = createBubble(role);
  if (!bubble) return null;
  bubble.body.innerHTML = formatMarkdown(text);
  return bubble;
}

function beginAssistantBubble() {
  const bubble = createBubble("assistant");
  if (!bubble) return null;
  bubble.body.classList.add("is-streaming");
  bubble.body.innerHTML =
    '<span class="typing" aria-label="Thinking" aria-hidden="true"><i></i><i></i><i></i></span>';
  return bubble;
}

function appendSystemNote(text, actionLink = null, atTop = false) {
  const host = document.getElementById("thread");
  if (!host) return;

  host.querySelector(".thread-empty")?.remove();

  const note = document.createElement("div");
  note.className = "msg msg-system";

  const span = document.createElement("span");
  span.textContent = text;
  note.append(span);

  if (actionLink) {
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = actionLink.label;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      actionLink.onClick();
    });
    note.append(link);
  }

  if (atTop) {
    host.prepend(note);
  } else {
    host.append(note);
  }
  scrollThreadToBottom();
}

/** Removes committed bubbles while preserving any in-flight turn bubbles. */
function clearThreadExceptInflight() {
  const host = document.getElementById("thread");
  if (!host) return;

  host.querySelector(".thread-empty")?.remove();
  host.querySelectorAll(".msg").forEach((el) => {
    if (el === inflightTurn?.userBubble || el === inflightTurn?.assistantWrap) return;
    el.remove();
  });
}

function scrollThreadToBottom() {
  const host = document.getElementById("thread");
  const last = host?.lastElementChild;
  last?.scrollIntoView({ block: "end" });
}

async function loadChatThread() {
  if (chatBusy) return;

  if (!currentTabId) {
    chatTurns = [];
    renderThread();
    return;
  }

  try {
    const result = await send("GET_CHAT_THREAD", {}, currentTabId);
    chatTurns = result?.ok && Array.isArray(result.data?.turns) ? result.data.turns : [];
  } catch {
    chatTurns = [];
  }
  renderThread();
}

function submitChat(rawText) {
  const text = (rawText || "").trim();
  if (!text) return; // Edge case 2.1-07: ignore empty/whitespace sends.

  // Edge case 2.1-05: a second message aborts the first stream.
  if (chatBusy) settleInflightTurn();

  const requestId = crypto.randomUUID();
  activeChatRequestId = requestId;
  chatBusy = true;

  const userBubble = appendBubble("user", text);
  const assistant = beginAssistantBubble();
  inflightTurn = {
    userBubble: userBubble?.wrap || null,
    assistantWrap: assistant?.wrap || null,
    assistantBody: assistant?.body || null,
    partial: "",
    userText: text
  };

  scrollThreadToBottom();
  refreshComposer();

  try {
    getChatPort().postMessage({
      v: MESSAGE_VERSION,
      type: "CHAT_TURN",
      requestId,
      tabId: currentTabId,
      payload: { message: text }
    });
  } catch {
    finishChatTurn({ ok: false, code: "PORT_ERROR", error: "Could not reach the Sahayak service worker." });
  }
}

function finishChatTurn(message) {
  const turn = inflightTurn;

  if (turn) {
    if (message.ok) {
      const finalText = message.data?.text || turn.partial || "";
      if (turn.assistantBody) {
        turn.assistantBody.classList.remove("is-streaming");
        turn.assistantBody.innerHTML = formatMarkdown(finalText);
      }
      chatTurns.push({ role: "user", text: turn.userText });
      chatTurns.push({ role: "model", text: finalText });
    } else {
      turn.assistantWrap?.remove();
      handleChatError(message);
    }
  }

  inflightTurn = null;
  chatBusy = false;
  activeChatRequestId = null;
  refreshComposer();
  scrollThreadToBottom();
}

/**
 * Drops an in-flight turn locally (and tells the worker to stop) before starting
 * a new one, keeping the panel in sync with what the worker actually persisted.
 */
function settleInflightTurn() {
  try {
    getChatPort().postMessage({ type: "CHAT_CANCEL", requestId: activeChatRequestId });
  } catch {
    // Port already gone; nothing to cancel.
  }

  if (inflightTurn) {
    inflightTurn.userBubble?.remove();
    inflightTurn.assistantWrap?.remove();
  }

  inflightTurn = null;
  chatBusy = false;
  activeChatRequestId = null;
}

function handleChatError(message) {
  const code = message?.code;
  if (code === "MISSING_KEY" || code === "NO_KEY") {
    appendSystemNote("Set your Gemini API key in Settings before Sahayak can chat.", {
      label: "Open Settings",
      onClick: () => chrome.runtime.openOptionsPage()
    });
  } else if (code === "INVALID_KEY") {
    appendSystemNote("Invalid Gemini API key. Please check your API key in Settings.", {
      label: "Open Settings",
      onClick: () => chrome.runtime.openOptionsPage()
    });
  } else if (code === "EMPTY_EXTRACTION") {
    appendSystemNote(
      message.error ||
        "Couldn't read enough text from this page to answer questions. Try highlighting text to explain instead."
    );
  } else {
    appendSystemNote(message?.error || "Chat failed. Please try again.");
  }
}

/** Keeps the composer in step with page support, key presence, and busy state. */
function refreshComposer() {
  const promptEl = document.getElementById("prompt");
  const sendBtn = document.getElementById("send");
  const wrap = document.getElementById("composer-wrap");

  const active = document.querySelector(".section.is-active");
  wrap?.classList.toggle("is-hidden", active?.id !== "section-chat");

  const ready = Boolean(lastTabInfo?.supported) && hasGeminiKey;
  if (promptEl) promptEl.disabled = !ready;
  if (sendBtn) sendBtn.disabled = !ready;
}

/* ==========================================================================
   CONTEXT-MENU ACTIONS (Slice 2.2)
   ========================================================================== */

const CONTEXT_ACTION_META = {
  explain: { title: "Explanation", loading: "Explaining with Gemini…" },
  translate: { title: "Translation", loading: "Translating with Gemini…" },
  draft: { title: "Draft reply", loading: "Drafting a reply with Gemini…" }
};

let lastActionData = null;
let actionRunSeq = 0;
let actionConsuming = false;

/**
 * Pulls a right-click action parked by the service worker and runs it.
 * Safe to call repeatedly: the worker clears the record on the first read.
 */
async function consumePendingAction() {
  if (actionConsuming) return;
  actionConsuming = true;
  try {
    const result = await send("GET_PENDING_CONTEXT_ACTION", {});
    if (result?.ok && result.data) {
      runContextAction(result.data);
    }
  } catch {
    // Nothing to do; the user can retry from the right-click menu.
  } finally {
    actionConsuming = false;
  }
}

async function runContextAction(pending) {
  const meta = CONTEXT_ACTION_META[pending?.action];
  if (!meta) return;

  const runId = ++actionRunSeq; // Edge case 2.2-03: last action wins.
  switchToTab("actions");
  hideNotice("action-notice");

  const pane = document.getElementById("action-result-pane");
  const quoteEl = document.getElementById("action-quote");
  const truncateEl = document.getElementById("action-truncate-notice");
  const loadingEl = document.getElementById("action-loading");
  const loadingText = document.getElementById("action-loading-text");
  const outputEl = document.getElementById("action-output");
  const actionsEl = document.getElementById("action-actions");
  const badge = document.getElementById("action-result-badge");

  document.getElementById("action-result-title").textContent = meta.title;
  if (loadingText) loadingText.textContent = meta.loading;
  quoteEl.textContent = pending.selectionText || "";
  if (truncateEl) truncateEl.hidden = true;
  if (badge) {
    badge.hidden = true;
    badge.textContent = "";
  }
  outputEl.hidden = true;
  actionsEl.hidden = true;
  pane.hidden = false;
  loadingEl.hidden = false;

  try {
    const result = await send(
      "CONTEXT_ACTION",
      {
        action: pending.action,
        selection: pending.selectionText || "",
        title: pending.title || "",
        url: pending.url || "",
        windowId: pending.windowId
      },
      pending.tabId
    );

    if (runId !== actionRunSeq) return;

    if (!result?.ok) {
      loadingEl.hidden = true;
      if (!lastActionData) {
        pane.hidden = true;
      } else {
        outputEl.hidden = false;
        actionsEl.hidden = false;
      }
      showActionError(result?.code, result?.error);
      return;
    }

    renderActionResult(pending.action, result.data);
  } catch (error) {
    if (runId !== actionRunSeq) return;
    loadingEl.hidden = true;
    if (!lastActionData) {
      pane.hidden = true;
    }
    showNotice("action-notice", error?.message || "Failed to reach the Sahayak service worker.", "danger");
  }
}

function renderActionResult(action, data) {
  const meta = CONTEXT_ACTION_META[action] || CONTEXT_ACTION_META.explain;

  let text = "";
  let badgeText = "";
  if (action === "translate") {
    text = data.translation || "";
    badgeText = data.targetLabel || "Hindi";
  } else if (action === "draft") {
    text = data.draft || "";
    badgeText = data.tone || "";
  } else {
    text = data.explanation || "";
    badgeText = data.language === "hinglish" ? "Hinglish" : "English";
  }

  lastActionData = { action, text };

  const badge = document.getElementById("action-result-badge");
  const quoteEl = document.getElementById("action-quote");
  const truncateEl = document.getElementById("action-truncate-notice");
  const outputEl = document.getElementById("action-output");
  const actionsEl = document.getElementById("action-actions");

  document.getElementById("action-result-title").textContent = meta.title;

  if (badge) {
    badge.hidden = !badgeText;
    badge.textContent = badgeText;
  }

  quoteEl.textContent = data.selection || "";
  if (truncateEl) truncateEl.hidden = !data.truncated;

  outputEl.innerHTML = formatMarkdown(text);
  document.getElementById("action-loading").hidden = true;
  outputEl.hidden = false;
  actionsEl.hidden = false;
  document.getElementById("action-result-pane").hidden = false;
}

function showActionError(code, fallbackMessage) {
  if (code === "MISSING_KEY" || code === "NO_KEY") {
    showNotice("action-notice", "Set your Gemini API key in Settings first.", "warn", {
      label: "Open Settings",
      onClick: () => chrome.runtime.openOptionsPage()
    });
  } else if (code === "INVALID_KEY") {
    showNotice("action-notice", "Invalid Gemini API key. Please check Settings.", "danger", {
      label: "Open Settings",
      onClick: () => chrome.runtime.openOptionsPage()
    });
  } else if (code === "NO_SELECTION") {
    showNotice(
      "action-notice",
      "Couldn't read the selected text. Some editors block selection — try selecting again.",
      "warn"
    );
  } else if (code === "SENSITIVE_FIELD") {
    showNotice("action-notice", "That text is from a password or credential field and cannot be sent.", "danger");
  } else {
    showNotice("action-notice", fallbackMessage || "The action failed. Please try again.", "danger");
  }
}

/* ==========================================================================
   SCREENSHOT & ASK (Slice 2.3)
   ========================================================================== */

/** Largest edge (px) uploaded to the model after cropping (edge case 2.3-07). */
const MAX_CAPTURE_EDGE = 1536;
/** Shrink further while the encoded PNG is larger than this many characters. */
const MAX_CAPTURE_CHARS = 4_000_000;
/** Crops smaller than this in source pixels fall back to the full image (2.3-04). */
const MIN_CROP_PX = 8;
/** Crop rectangles smaller than this in display pixels are treated as a stray click. */
const MIN_CROP_DISPLAY_PX = 6;

let captureData = null; // { dataUrl, url, title, naturalWidth, naturalHeight }
let captureTabId = null;
let cropRect = null; // display-space { x, y, w, h }
let cropDrag = null; // { startX, startY } while a drag is in progress
let screenshotBusy = false;
let lastScreenshotData = null; // { answer }

function resetCrop() {
  cropRect = null;
  cropDrag = null;
  const box = document.getElementById("crop-box");
  if (box) {
    box.hidden = true;
    box.style.left = "";
    box.style.top = "";
    box.style.width = "";
    box.style.height = "";
  }
}

function resetCapture({ hideStage = true } = {}) {
  captureData = null;
  captureTabId = null;
  const img = document.getElementById("capture-image");
  if (img) img.removeAttribute("src");
  resetCrop();
  if (hideStage) {
    const card = document.getElementById("capture-stage-card");
    if (card) card.hidden = true;
  }
  const question = document.getElementById("screenshot-question");
  if (question) question.value = "";
  refreshScreenshotButton();
}

/** Enables the ask button only when there is a capture, a question, a key, and no in-flight job. */
function refreshScreenshotButton() {
  const btn = document.getElementById("btn-ask-screenshot");
  if (!btn) return;
  const question = document.getElementById("screenshot-question");
  const ready = Boolean(captureData) && Boolean(question?.value.trim()) && !screenshotBusy && hasGeminiKey;
  btn.disabled = !ready;
  btn.title = hasGeminiKey ? "" : "Set your Gemini API key in Settings first";
}

async function startCapture() {
  hideNotice("capture-notice");
  const btn = document.getElementById("btn-capture");
  const label = document.getElementById("btn-capture-text");
  const original = label?.textContent;
  if (btn) btn.disabled = true;
  if (label) label.textContent = "Capturing…";

  try {
    const win = await chrome.windows.getCurrent();
    const result = await send("CAPTURE_SCREENSHOT", { windowId: win.id }, currentTabId);
    if (!result?.ok) {
      showCaptureError(result?.code, result?.error);
      return;
    }
    showCapture(result.data);
  } catch (error) {
    showNotice(
      "capture-notice",
      error?.message || "Could not reach the Sahayak service worker.",
      "danger"
    );
  } finally {
    if (btn) btn.disabled = false;
    if (label && original) label.textContent = original;
  }
}

function showCapture(data) {
  captureData = {
    dataUrl: data?.dataUrl || "",
    url: data?.url || "",
    title: data?.title || "",
    naturalWidth: 0,
    naturalHeight: 0
  };
  captureTabId = data?.tabId ?? currentTabId;
  resetCrop();

  const card = document.getElementById("capture-stage-card");
  const img = document.getElementById("capture-image");
  const dims = document.getElementById("capture-dims");
  if (!img || !captureData.dataUrl) return;

  img.onload = () => {
    captureData.naturalWidth = img.naturalWidth || 0;
    captureData.naturalHeight = img.naturalHeight || 0;
    if (dims) {
      dims.textContent = `${captureData.naturalWidth} × ${captureData.naturalHeight}px visible`;
    }
    refreshScreenshotButton();
  };
  img.src = captureData.dataUrl;
  if (card) card.hidden = false;
  refreshScreenshotButton();
}

function localPoint(event, wrap) {
  const rect = wrap.getBoundingClientRect();
  return {
    x: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
    y: Math.min(Math.max(event.clientY - rect.top, 0), rect.height)
  };
}

function drawCropBox() {
  const box = document.getElementById("crop-box");
  if (!box) return;
  if (!cropRect || cropRect.w <= 0 || cropRect.h <= 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.style.left = `${cropRect.x}px`;
  box.style.top = `${cropRect.y}px`;
  box.style.width = `${cropRect.w}px`;
  box.style.height = `${cropRect.h}px`;
}

function handleCropPointerDown(event) {
  const wrap = document.getElementById("capture-image-wrap");
  if (!captureData || !wrap) return;
  event.preventDefault();
  const point = localPoint(event, wrap);
  cropDrag = { startX: point.x, startY: point.y };
  cropRect = { x: point.x, y: point.y, w: 0, h: 0 };
  drawCropBox();
  wrap.setPointerCapture?.(event.pointerId);
}

function handleCropPointerMove(event) {
  if (!cropDrag) return;
  const wrap = document.getElementById("capture-image-wrap");
  if (!wrap) return;
  const point = localPoint(event, wrap);
  cropRect = {
    x: Math.min(cropDrag.startX, point.x),
    y: Math.min(cropDrag.startY, point.y),
    w: Math.abs(point.x - cropDrag.startX),
    h: Math.abs(point.y - cropDrag.startY)
  };
  drawCropBox();
}

function handleCropPointerUp(event) {
  if (!cropDrag) return;
  cropDrag = null;
  const wrap = document.getElementById("capture-image-wrap");
  wrap?.releasePointerCapture?.(event.pointerId);

  // Edge case 2.3-04: a stray click or sliver is ignored, keeping the full image.
  if (!cropRect || cropRect.w < MIN_CROP_DISPLAY_PX || cropRect.h < MIN_CROP_DISPLAY_PX) {
    resetCrop();
  }
  refreshScreenshotButton();
}

function drawToDataUrl(canvas, ctx, img, sx, sy, sw, sh, outW, outH) {
  canvas.width = Math.max(1, outW);
  canvas.height = Math.max(1, outH);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

/**
 * Renders the (optionally cropped) screenshot to a PNG data URL, downscaling when
 * the source is large. Returns null when the image is not ready yet.
 */
function computeCropDataUrl() {
  const img = document.getElementById("capture-image");
  if (!captureData || !img || !img.naturalWidth || !img.naturalHeight) return null;

  const displayWidth = img.clientWidth || captureData.naturalWidth;
  const scale = captureData.naturalWidth / displayWidth;

  let sx = 0;
  let sy = 0;
  let sw = captureData.naturalWidth;
  let sh = captureData.naturalHeight;

  if (cropRect && cropRect.w > 0 && cropRect.h > 0) {
    const nw = cropRect.w * scale;
    const nh = cropRect.h * scale;
    // Edge case 2.3-04: reject inverted / zero-size rectangles; keep the full image.
    if (nw >= MIN_CROP_PX && nh >= MIN_CROP_PX) {
      sx = Math.max(0, Math.min(Math.round(cropRect.x * scale), captureData.naturalWidth - 1));
      sy = Math.max(0, Math.min(Math.round(cropRect.y * scale), captureData.naturalHeight - 1));
      sw = Math.max(MIN_CROP_PX, Math.min(Math.round(nw), captureData.naturalWidth - sx));
      sh = Math.max(MIN_CROP_PX, Math.min(Math.round(nh), captureData.naturalHeight - sy));
    }
  }

  let outW = sw;
  let outH = sh;
  const longest = Math.max(sw, sh);
  if (longest > MAX_CAPTURE_EDGE) {
    const factor = MAX_CAPTURE_EDGE / longest;
    outW = Math.round(sw * factor);
    outH = Math.round(sh * factor);
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  let dataUrl = drawToDataUrl(canvas, ctx, img, sx, sy, sw, sh, outW, outH);
  let guard = 0;
  while (dataUrl && dataUrl.length > MAX_CAPTURE_CHARS && guard < 4) {
    outW = Math.max(1, Math.round(outW * 0.75));
    outH = Math.max(1, Math.round(outH * 0.75));
    dataUrl = drawToDataUrl(canvas, ctx, img, sx, sy, sw, sh, outW, outH);
    guard += 1;
  }
  return dataUrl;
}

async function askScreenshot() {
  if (!captureData || screenshotBusy) return;

  const questionEl = document.getElementById("screenshot-question");
  const question = (questionEl?.value || "").trim();
  // Edge case 2.3-06: a question is required.
  if (!question) {
    showNotice("capture-notice", "Type a question about the screenshot first.", "warn");
    return;
  }

  const imageDataUrl = computeCropDataUrl();
  if (!imageDataUrl) {
    showNotice("capture-notice", "Could not prepare the screenshot. Please capture again.", "danger");
    return;
  }

  hideNotice("capture-notice");
  screenshotBusy = true;
  refreshScreenshotButton();

  const pane = document.getElementById("screenshot-result-pane");
  const loadingEl = document.getElementById("screenshot-loading");
  const outputEl = document.getElementById("screenshot-output");
  const actionsEl = document.getElementById("screenshot-actions");
  const quoteEl = document.getElementById("screenshot-question-quote");

  if (quoteEl) quoteEl.textContent = question;
  if (outputEl) outputEl.hidden = true;
  if (actionsEl) actionsEl.hidden = true;
  if (pane) pane.hidden = false;
  if (loadingEl) loadingEl.hidden = false;

  try {
    const result = await send(
      "SCREENSHOT_ASK",
      {
        question,
        imageDataUrl,
        url: captureData?.url || "",
        title: captureData?.title || ""
      },
      captureTabId ?? currentTabId
    );

    if (!result?.ok) {
      if (loadingEl) loadingEl.hidden = true;
      if (pane && !lastScreenshotData) pane.hidden = true;
      showCaptureError(result?.code, result?.error);
      return;
    }

    renderScreenshotResult(result.data);
  } catch (error) {
    if (loadingEl) loadingEl.hidden = true;
    if (pane && !lastScreenshotData) pane.hidden = true;
    showNotice(
      "capture-notice",
      error?.message || "Failed to reach the Sahayak service worker.",
      "danger"
    );
  } finally {
    screenshotBusy = false;
    refreshScreenshotButton();
  }
}

function renderScreenshotResult(data) {
  lastScreenshotData = { answer: data?.answer || "" };

  const pane = document.getElementById("screenshot-result-pane");
  const loadingEl = document.getElementById("screenshot-loading");
  const outputEl = document.getElementById("screenshot-output");
  const actionsEl = document.getElementById("screenshot-actions");
  const badge = document.getElementById("screenshot-badge");
  const quoteEl = document.getElementById("screenshot-question-quote");

  if (quoteEl) quoteEl.textContent = data?.question || "";
  if (badge) badge.textContent = data?.model ? `Flash (${data.model})` : "Flash (vision)";
  if (outputEl) outputEl.innerHTML = formatMarkdown(data?.answer || "");
  if (loadingEl) loadingEl.hidden = true;
  if (outputEl) outputEl.hidden = false;
  if (actionsEl) actionsEl.hidden = false;
  if (pane) pane.hidden = false;
}

function showCaptureError(code, fallbackMessage) {
  if (code === "MISSING_KEY" || code === "NO_KEY") {
    showNotice("capture-notice", "Set your Gemini API key in Settings first.", "warn", {
      label: "Open Settings",
      onClick: () => chrome.runtime.openOptionsPage()
    });
  } else if (code === "INVALID_KEY" || code === "UNAUTHORIZED") {
    showNotice("capture-notice", fallbackMessage || "Invalid Gemini API key. Please check Settings.", "danger", {
      label: "Open Settings",
      onClick: () => chrome.runtime.openOptionsPage()
    });
  } else if (code === "NO_QUESTION") {
    showNotice("capture-notice", "Type a question about the screenshot first.", "warn");
  } else if (code === "RATE_LIMIT") {
    showNotice("capture-notice", fallbackMessage || "Gemini is rate limited. Please wait a moment and try again.", "warn");
  } else {
    showNotice("capture-notice", fallbackMessage || "The screenshot request failed. Please try again.", "danger");
  }
}

/* ==========================================================================
   AGENT — SCANNER AND BADGES (Slice 3.1)
   ========================================================================== */

let lastScanData = null;
let scanTabId = null;
let scanBusy = false;

/** Compact view of a node for the model — never includes markup (edge case 3.1-15). */
function toCompactNode(node) {
  const compact = {
    n: node.n,
    tag: node.tag
  };
  if (node.role) compact.role = node.role;
  if (node.type) compact.type = node.type;
  if (node.text) compact.text = node.text;
  if (node.placeholder) compact.placeholder = node.placeholder;
  if (node.href) compact.href = node.href;
  if (node.disabled) compact.disabled = true;
  if (node.sensitive) compact.sensitive = true;
  if (node.consequential) compact.consequential = true;
  return compact;
}

function describeNode(node) {
  const parts = [node.text || `(unlabelled ${node.tag})`];
  if (node.type && node.tag === "input") parts.push(`[${node.type}]`);
  else if (node.tag !== "input") parts.push(`<${node.tag}>`);
  return parts.join(" ");
}

function renderScan(data) {
  const pane = document.getElementById("agent-result-pane");
  const badge = document.getElementById("agent-scan-badge");
  const truncateBadge = document.getElementById("agent-truncate-badge");
  const summaryEl = document.getElementById("agent-scan-summary");
  const framesNote = document.getElementById("agent-frames-note");
  const listEl = document.getElementById("agent-node-list");
  const jsonEl = document.getElementById("agent-json-preview");
  const detailsEl = document.getElementById("agent-json-details");
  const loadingEl = document.getElementById("agent-loading");
  const actionsEl = document.getElementById("agent-actions");

  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];

  if (badge) badge.textContent = `Generation ${data?.scanGeneration ?? 1}`;
  if (truncateBadge) truncateBadge.hidden = !data?.truncated;

  if (summaryEl) {
    const total = data?.totalFound ?? nodes.length;
    summaryEl.textContent = data?.truncated
      ? `Numbered ${nodes.length} of ${total} elements — the rest were dropped to keep the map small. Scroll and rescan to reach them.`
      : `Numbered ${nodes.length} interactive element${nodes.length === 1 ? "" : "s"} on this page.`;
  }

  if (framesNote) framesNote.hidden = !data?.containsFrames;

  if (listEl) {
    listEl.textContent = "";
    if (!nodes.length) {
      const empty = document.createElement("li");
      empty.className = "node-empty";
      empty.textContent = "No interactive elements found on this page.";
      listEl.appendChild(empty);
    }
    for (const node of nodes) {
      const item = document.createElement("li");
      item.className = "node-item";

      const nEl = document.createElement("span");
      nEl.className = "node-n";
      nEl.textContent = String(node.n);

      const textEl = document.createElement("span");
      textEl.className = "node-text";
      textEl.textContent = describeNode(node);

      item.append(nEl, textEl);

      if (node.sensitive) {
        const tag = document.createElement("span");
        tag.className = "node-flag node-flag-sensitive";
        tag.textContent = "sensitive";
        item.appendChild(tag);
      } else if (node.consequential) {
        const tag = document.createElement("span");
        tag.className = "node-flag node-flag-consequential";
        tag.textContent = "consequential";
        item.appendChild(tag);
      }
      if (node.disabled) {
        const tag = document.createElement("span");
        tag.className = "node-flag";
        tag.textContent = "disabled";
        item.appendChild(tag);
      }

      listEl.appendChild(item);
    }
  }

  const compact = {
    url: data?.url || "",
    title: data?.title || "",
    scanGeneration: data?.scanGeneration ?? 1,
    nodes: nodes.map(toCompactNode)
  };
  if (jsonEl) jsonEl.textContent = JSON.stringify(compact, null, 2);
  if (detailsEl) detailsEl.open = false;

  if (loadingEl) loadingEl.hidden = true;
  if (actionsEl) actionsEl.hidden = false;
  if (pane) pane.hidden = false;
}

function showScanError(code, fallbackMessage) {
  if (code === "BLOCKED_URL") {
    showNotice("agent-notice", fallbackMessage || "This page is blocked for safety reasons.", "danger");
  } else if (code === "UNSUPPORTED_PAGE" || code === "NO_TAB") {
    showNotice("agent-notice", fallbackMessage || "Open a normal http/https webpage to scan it.", "warn");
  } else if (code === "SCAN_FAILED") {
    showNotice("agent-notice", fallbackMessage || "Could not scan this page. Reload it and try again.", "danger");
  } else {
    showNotice("agent-notice", fallbackMessage || "Could not scan this page.", "danger");
  }
}

/** Smallest footprint capture-like guard so a scan never leaves stale badges behind. */
function forgetScan() {
  lastScanData = null;
  scanTabId = null;
  const pane = document.getElementById("agent-result-pane");
  if (pane) pane.hidden = true;
  const loadingEl = document.getElementById("agent-loading");
  if (loadingEl) loadingEl.hidden = true;
}

/** Scanning needs a readable page, but no API key — it never calls a model. */
function refreshScanButton() {
  const btn = document.getElementById("btn-scan-page");
  const clearBtn = document.getElementById("btn-clear-badges");
  if (!btn) return;

  const supported = Boolean(lastTabInfo?.supported);
  btn.disabled = !supported || scanBusy;
  btn.title = supported
    ? "Number the buttons, links, and fields on this page"
    : "Open an http/https webpage to scan it";
  if (clearBtn) clearBtn.disabled = !supported;
}

async function scanPage() {
  if (scanBusy) return;
  scanBusy = true;

  const pane = document.getElementById("agent-result-pane");
  const loadingEl = document.getElementById("agent-loading");
  const actionsEl = document.getElementById("agent-actions");
  const btn = document.getElementById("btn-scan-page");
  const btnText = document.getElementById("btn-scan-page-text");

  hideNotice("agent-notice");
  if (pane) pane.hidden = false;
  if (loadingEl) loadingEl.hidden = false;
  if (actionsEl) actionsEl.hidden = true;
  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = "Scanning…";

  try {
    const result = await send("SCAN_PAGE", {}, currentTabId);
    if (!result?.ok) {
      if (pane) pane.hidden = true;
      showScanError(result?.code, result?.error);
      return;
    }
    lastScanData = result.data;
    scanTabId = currentTabId;
    renderScan(result.data);
  } catch {
    if (pane) pane.hidden = true;
    showScanError(null, "Could not scan this page. Please try again.");
  } finally {
    scanBusy = false;
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = "Scan page";
  }
}

async function clearBadges() {
  try {
    await send("CLEAR_OVERLAY", {}, currentTabId);
  } catch {
    // Clearing is best effort; the panel state is reset regardless.
  }
  hideNotice("agent-notice");
  forgetScan();
  forgetFind();
}

/* ==========================================================================
   AGENT — FIND IT FOR ME (Slice 3.2)
   ========================================================================== */

let findBusy = false;

/** Find-it needs a readable page and a key; the model only ever picks a number. */
function refreshFindButton() {
  const btn = document.getElementById("btn-find-element");
  if (!btn) return;

  const supported = Boolean(lastTabInfo?.supported);
  btn.disabled = !supported || !hasGeminiKey || findBusy;
  btn.title = !supported
    ? "Open an http/https webpage to use Find it"
    : !hasGeminiKey
      ? "Add a Gemini API key in Settings to use Find it"
      : "Highlight the element matching your description";
}

function showFindError(code, fallbackMessage) {
  if (code === "NO_QUESTION") {
    showNotice("find-notice", "Describe what you want Sahayak to find.", "warn");
  } else if (code === "BLOCKED_URL") {
    showNotice("find-notice", fallbackMessage || "This page is blocked for safety reasons.", "danger");
  } else if (code === "UNSUPPORTED_PAGE" || code === "NO_TAB") {
    showNotice("find-notice", fallbackMessage || "Open a normal http/https webpage first.", "warn");
  } else if (code === "NO_ELEMENTS") {
    showNotice("find-notice", fallbackMessage || "Sahayak found no interactive elements on this page.", "warn");
  } else if (code === "NOT_FOUND") {
    showNotice("find-notice", fallbackMessage || "Sahayak could not identify that element. Try describing it differently.", "warn");
  } else if (code === "STALE_SCAN" || code === "NODE_GONE") {
    showNotice("find-notice", fallbackMessage || "The page kept changing. Rescan and try again.", "warn");
  } else if (code === "RATE_LIMIT") {
    showNotice("find-notice", fallbackMessage || "The AI is rate limited. Please wait a moment and try again.", "warn");
  } else {
    showNotice("find-notice", fallbackMessage || "Could not find that element. Please try again.", "danger");
  }
}

function renderFindResult(data) {
  const pane = document.getElementById("find-result-pane");
  const confidenceBadge = document.getElementById("find-confidence-badge");
  const numberBadge = document.getElementById("find-number-badge");
  const reasonEl = document.getElementById("find-reason");
  const targetEl = document.getElementById("find-target");
  const clarifyNote = document.getElementById("find-clarify-note");

  const matched = Boolean(data?.matched);

  if (confidenceBadge) {
    const confidence = data?.confidence || "low";
    confidenceBadge.textContent = confidence;
    confidenceBadge.className = `badge ${confidence === "high" ? "badge-accent" : "badge-outline"}`;
  }

  if (numberBadge) {
    numberBadge.hidden = !matched;
    if (matched) numberBadge.textContent = `#${data.n}`;
  }

  if (reasonEl) reasonEl.textContent = data?.reason || "";

  if (targetEl) {
    if (matched && data?.node) {
      targetEl.textContent = `#${data.n} · ${describeNode(data.node)}`;
      targetEl.hidden = false;
    } else {
      targetEl.textContent = "";
      targetEl.hidden = true;
    }
  }

  if (clarifyNote) clarifyNote.hidden = matched;

  if (pane) pane.hidden = false;
}

function forgetFind() {
  const pane = document.getElementById("find-result-pane");
  if (pane) pane.hidden = true;
  hideNotice("find-notice");
}

/** Dismiss the agent card without touching the session; Stop ends the run. */
function forgetAgentRun() {
  const pane = document.getElementById("agent-proposal-pane");
  if (pane) pane.hidden = true;
  hideNotice("agent-run-notice");
}

async function findElementForMe() {
  if (findBusy) return;

  const input = document.getElementById("find-question");
  const question = String(input?.value || "").trim();
  if (!question) {
    showFindError("NO_QUESTION");
    return;
  }

  findBusy = true;
  const btn = document.getElementById("btn-find-element");
  const btnText = document.getElementById("btn-find-element-text");

  hideNotice("find-notice");
  const pane = document.getElementById("find-result-pane");
  if (pane) pane.hidden = true;
  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = "Finding…";

  try {
    const result = await send("FIND_ELEMENT", { question }, currentTabId);
    if (!result?.ok) {
      showFindError(result?.code, result?.error);
      return;
    }
    renderFindResult(result.data);
  } catch {
    showFindError(null, "Could not find that element. Please try again.");
  } finally {
    findBusy = false;
    if (btnText) btnText.textContent = "Find it";
    refreshFindButton();
  }
}

/* ==========================================================================
   AGENT — APPROVAL LOOP (Slice 3.3 / 3.5)
   ========================================================================== */

let agentBusy = false;
let agentState = null;
let agentConfirmArmed = false;

/**
 * Slice 3.5 — Opens a bundled practice page in the active window as a new tab,
 * then focuses that tab so the user can use the side panel beside it.
 * @param {string} path  Relative extension path, e.g. "test-pages/form.html"
 */
async function openPracticePage(path) {
  try {
    const url = chrome.runtime.getURL(path);
    const win = await chrome.windows.getCurrent();
    const tab = await chrome.tabs.create({ url, windowId: win.id, active: true });
    // Briefly notify so the user knows to use the panel on that tab.
    showNotice(
      "agent-run-notice",
      "Practice page opened — switch to it, then start the agent here.",
      "warn"
    );
    // Refresh so the panel detects the new tab and enables the Start button.
    setTimeout(() => {
      refresh();
    }, 600);
    return tab;
  } catch (err) {
    showNotice("agent-run-notice", `Could not open practice page: ${err?.message || err}`, "danger");
  }
}

/** The agent needs a readable page and a key; it only ever proposes. */
function refreshAgentStartButton() {
  const btn = document.getElementById("btn-agent-start");
  if (!btn) return;

  const supported = Boolean(lastTabInfo?.supported);
  const running = Boolean(agentState?.active);
  const isPractice = Boolean(lastTabInfo?.isPractice);

  // Slice 4.3: also allow owned origins (http/https pages the user has declared).
  let isOwned = false;
  if (supported && lastTabInfo?.url) {
    try {
      const origin = new URL(lastTabInfo.url).origin;
      isOwned = currentOwnedOrigins.includes(origin);
    } catch { /* ignore */ }
  }

  const canStart = (isPractice || supported) && hasGeminiKey && !agentBusy && !running;

  btn.disabled = !canStart;
  btn.title = !hasGeminiKey
    ? "Add a Gemini API key in Settings to run the agent"
    : running
      ? "An errand is already running"
      : !isPractice && !supported
        ? "Open a practice page or an http/https webpage to run the agent"
        : "Start a one-step-at-a-time agent run";

  // Hide the practice / ownership cards while a run is active to keep the UI clean.
  const practiceCard = document.getElementById("practice-pages-card");
  const ownedCard = document.getElementById("owned-origins-card");
  if (practiceCard) practiceCard.hidden = running;
  if (ownedCard) ownedCard.hidden = running;

  // Update the "Allow this origin" button label based on whether the current
  // page is already owned.
  const addBtn = document.getElementById("btn-add-owned-origin");
  const addBtnText = document.getElementById("btn-add-owned-text");
  if (addBtn && addBtnText) {
    if (isOwned) {
      addBtnText.textContent = "Remove this origin";
      addBtn.classList.remove("btn-primary");
      addBtn.classList.add("btn-secondary");
    } else {
      addBtnText.textContent = "Allow this origin";
      addBtn.classList.remove("btn-secondary");
      addBtn.classList.add("btn-primary");
    }
    // Disable if no http/https tab is active
    addBtn.disabled = !supported;
  }
}

function showAgentRunError(code, fallbackMessage) {
  const friendly = {
    NO_GOAL: "Tell Sahayak what you want it to do.",
    NO_TAB: "Open a normal web page first.",
    UNSUPPORTED_PAGE: "Sahayak can act only on http/https pages.",
    NO_ELEMENTS: "Sahayak found no interactive elements on this page.",
    NO_SESSION: "No agent run is active.",
    SENSITIVE_BLOCKED: "Sahayak refused to type into a password, OTP, or card field.",
    RATE_LIMIT: "The AI is rate limited. Please wait a moment and try again.",
    NOT_PRACTICE_PAGE:
      "The agent can only run on practice pages or pages you have marked as owned. Use \"I own this page\" below to unlock this origin."
  };

  const soft =
    code === "NO_GOAL" ||
    code === "NO_ELEMENTS" ||
    code === "RATE_LIMIT" ||
    code === "NOT_PRACTICE_PAGE";

  showNotice(
    "agent-run-notice",
    friendly[code] || fallbackMessage || "The agent run failed. Please try again.",
    soft ? "warn" : "danger"
  );
}

function describeLogEntry(entry) {
  const proposed = entry?.proposed || {};
  if (proposed.type === "type") return `type "${proposed.value}" into #${proposed.n}`;
  if (proposed.type === "select") return `select "${proposed.value}" in #${proposed.n}`;
  if (proposed.type === "scroll") return proposed.n ? `scroll to #${proposed.n}` : `scroll ${proposed.direction || "down"}`;
  if (proposed.type === "click") return `click #${proposed.n}`;
  return proposed.type || "action";
}

function renderAgentLog(log) {
  const listEl = document.getElementById("agent-log-list");
  if (!listEl) return;

  listEl.textContent = "";
  if (!log.length) {
    const empty = document.createElement("li");
    empty.className = "node-empty";
    empty.textContent = "No steps yet.";
    listEl.appendChild(empty);
    return;
  }

  for (const entry of log) {
    const item = document.createElement("li");
    item.className = "node-item";

    const stepEl = document.createElement("span");
    stepEl.className = "node-n";
    stepEl.textContent = String(entry.step);

    const textEl = document.createElement("span");
    textEl.className = "node-text";
    textEl.textContent = describeLogEntry(entry);

    const flag = document.createElement("span");
    flag.className = "node-flag";
    if (entry.decision === "approved") flag.classList.add("node-flag-approved");
    else if (entry.decision === "dry-run") flag.classList.add("node-flag-dry-run");
    else if (entry.decision === "blocked" || entry.decision === "stopped") {
      flag.classList.add("node-flag-consequential");
    }
    flag.textContent = entry.decision;

    item.append(stepEl, textEl, flag);
    listEl.appendChild(item);
  }
}

function renderAgentState(state) {
  agentState = state || null;
  agentConfirmArmed = false;

  const pane = document.getElementById("agent-proposal-pane");
  const statusBadge = document.getElementById("agent-status-badge");
  const stepBadge = document.getElementById("agent-step-badge");
  const loadingEl = document.getElementById("agent-run-loading");
  const bodyEl = document.getElementById("agent-proposal-body");
  const sentenceEl = document.getElementById("agent-proposal-sentence");
  const reasonEl = document.getElementById("agent-proposal-reason");
  const targetEl = document.getElementById("agent-proposal-target");
  const warnEl = document.getElementById("agent-proposal-warn");
  const approveBtn = document.getElementById("btn-agent-approve");
  const skipBtn = document.getElementById("btn-agent-skip");
  const stopBtn = document.getElementById("btn-agent-stop");

  const status = state?.status || "idle";
  const pending = state?.pendingAction || null;
  const isDryRun = Boolean(state?.dryRun);

  if (statusBadge) statusBadge.textContent = status === "awaiting_approval" ? "waiting" : status;
  if (stepBadge) stepBadge.textContent = `Step ${(state?.step ?? 0) + 1} / ${state?.maxSteps ?? 20}`;

  const dryRunBadge = document.getElementById("agent-dry-run-badge");
  if (dryRunBadge) dryRunBadge.hidden = !isDryRun;

  if (loadingEl) loadingEl.hidden = !agentBusy;
  if (bodyEl) bodyEl.hidden = agentBusy;

  if (pending) {
    if (sentenceEl) sentenceEl.textContent = pending.sentence || "";

    // Slice 4.1: show which profile field supplied the proposed value.
    const profileNoteEl = document.getElementById("agent-proposal-profile-note");
    if (profileNoteEl) {
      if (pending.profileSource) {
        const fieldLabel = { name: "Name", college: "College", skills: "Skills", links: "Links" };
        profileNoteEl.textContent = `Value from your profile (${fieldLabel[pending.profileSource] || pending.profileSource})`;
        profileNoteEl.hidden = false;
      } else {
        profileNoteEl.hidden = true;
      }
    }

    if (reasonEl) reasonEl.textContent = pending.reason || "";

    if (targetEl) {
      if (pending.node) {
        targetEl.textContent = `#${pending.node.n} · ${describeNode(pending.node)}`;
        targetEl.hidden = false;
      } else {
        targetEl.hidden = true;
      }
    }

    if (warnEl) {
      if (pending.sensitive) {
        warnEl.textContent = "This is a password, OTP, or card field — Sahayak will not type here.";
        warnEl.hidden = false;
      } else if (pending.consequential) {
        warnEl.textContent = "This looks like a consequential action. Approve only if you are sure.";
        warnEl.hidden = false;
      } else {
        warnEl.hidden = true;
      }
    }
  } else if (!agentBusy && state && status !== "idle") {
    if (sentenceEl) {
      sentenceEl.textContent = state.message || (status === "done" ? "All steps complete." : "The run has ended.");
    }
    if (reasonEl) reasonEl.textContent = "";
    if (targetEl) targetEl.hidden = true;
    if (warnEl) warnEl.hidden = true;
  }

  if (approveBtn) {
    approveBtn.disabled = agentBusy || !pending || Boolean(pending.sensitive);
    if (isDryRun) {
      approveBtn.textContent = "Approve (dry-run)";
    } else {
      approveBtn.textContent = pending?.consequential ? "Approve (confirm)" : "Approve";
    }
  }
  if (skipBtn) skipBtn.disabled = agentBusy || !pending;
  if (stopBtn) stopBtn.disabled = agentBusy || !state?.active;

  renderAgentLog(state?.log || []);

  if (pane) {
    // Keep the pane visible while working so the spinner is seen even on the
    // very first start, when there is no state yet.
    pane.hidden = !agentBusy && (!state || (status === "idle" && (state.log || []).length === 0));
  }

  refreshAgentStartButton();

  // Slice 3.4: keep the Log section tab in sync every time agent state changes.
  renderFullLog(state?.log || []);
}

/**
 * Slice 4.2 — Renders the Skills section list and manages the add/edit form visibility.
 * Called by refresh() and whenever storage changes.
 * @param {Array<object>} skills
 */
function renderSkillsSection(skills) {
  const list = document.getElementById("skills-list");
  if (!list) return;

  list.replaceChildren();

  const KIND_LABELS = { summarise: "Summarise", chat: "Chat", draft: "Draft", agent: "Agent" };
  const LANG_LABELS = { en: "English", hinglish: "Hinglish" };

  if (!skills || !skills.length) {
    const empty = document.createElement("div");
    empty.className = "skills-empty";
    empty.innerHTML = '<span class="skills-empty-icon">⚡</span>No skills yet. Add one below or import from a JSON file.';
    list.appendChild(empty);
  } else {
    for (const skill of skills) {
      const card = document.createElement("div");
      card.className = "skill-card";
      card.dataset.skillId = skill.id;

      // Header row
      const header = document.createElement("div");
      header.className = "skill-card-header";

      const name = document.createElement("span");
      name.className = "skill-card-name";
      name.textContent = skill.name || "Unnamed skill";
      header.appendChild(name);

      const headerBtns = document.createElement("div");
      headerBtns.style.cssText = "display:flex;gap:4px;flex-shrink:0";

      const editBtn = document.createElement("button");
      editBtn.className = "btn-skill-icon";
      editBtn.title = "Edit skill";
      editBtn.setAttribute("aria-label", `Edit ${skill.name}`);
      editBtn.textContent = "✏️";
      editBtn.addEventListener("click", () => beginEditSkill(skill));
      headerBtns.appendChild(editBtn);

      const delBtn = document.createElement("button");
      delBtn.className = "btn-skill-icon danger";
      delBtn.title = "Delete skill";
      delBtn.setAttribute("aria-label", `Delete ${skill.name}`);
      delBtn.textContent = "🗑";
      delBtn.addEventListener("click", () => deleteSkillById(skill.id, skill.name));
      headerBtns.appendChild(delBtn);

      header.appendChild(headerBtns);
      card.appendChild(header);

      // Description
      if (skill.description) {
        const desc = document.createElement("p");
        desc.className = "skill-card-desc";
        desc.textContent = skill.description;
        card.appendChild(desc);
      }

      // Meta badges
      const meta = document.createElement("div");
      meta.className = "skill-card-meta";
      const kindBadge = document.createElement("span");
      kindBadge.className = "badge badge-subtle";
      kindBadge.textContent = KIND_LABELS[skill.kind] || skill.kind || "Chat";
      const langBadge = document.createElement("span");
      langBadge.className = "badge badge-outline";
      langBadge.textContent = LANG_LABELS[skill.language] || "English";
      meta.append(kindBadge, langBadge);
      card.appendChild(meta);

      // Footer: Run button
      const footer = document.createElement("div");
      footer.className = "skill-card-footer";
      const runBtn = document.createElement("button");
      runBtn.className = "btn-skill-run";
      runBtn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M5 3l14 9-14 9V3z"/></svg> Run`;
      runBtn.disabled = !hasGeminiKey;
      runBtn.title = hasGeminiKey ? `Run "${skill.name}" on this page` : "Add a Gemini key in Settings first";
      runBtn.addEventListener("click", () => runSkillById(skill.id, skill.name, skill.kind));
      footer.appendChild(runBtn);
      card.appendChild(footer);

      list.appendChild(card);
    }
  }

  // Show/hide the form's "add new" state only when no edit is in progress.
  resetSkillForm();
}

/** Resets the skill form to "add new" state and hides the cancel button if unused. */
function resetSkillForm() {
  const idInput = document.getElementById("skill-edit-id");
  const nameInput = document.getElementById("skill-name");
  const descInput = document.getElementById("skill-description");
  const kindSelect = document.getElementById("skill-kind");
  const langSelect = document.getElementById("skill-language");
  const promptArea = document.getElementById("skill-prompt");
  const formTitle = document.getElementById("skill-form-title");
  const saveBtn = document.getElementById("btn-save-skill");

  if (idInput) idInput.value = "";
  if (nameInput) nameInput.value = "";
  if (descInput) descInput.value = "";
  if (kindSelect) kindSelect.value = "chat";
  if (langSelect) langSelect.value = "en";
  if (promptArea) promptArea.value = "";
  if (formTitle) formTitle.textContent = "New skill";
  if (saveBtn) saveBtn.textContent = "Save skill";
  updateSkillPromptCount();
}

/** Fills the skill form for editing an existing skill. */
function beginEditSkill(skill) {
  const idInput = document.getElementById("skill-edit-id");
  const nameInput = document.getElementById("skill-name");
  const descInput = document.getElementById("skill-description");
  const kindSelect = document.getElementById("skill-kind");
  const langSelect = document.getElementById("skill-language");
  const promptArea = document.getElementById("skill-prompt");
  const formTitle = document.getElementById("skill-form-title");
  const saveBtn = document.getElementById("btn-save-skill");
  const formCard = document.getElementById("skill-form-card");

  if (idInput) idInput.value = skill.id || "";
  if (nameInput) nameInput.value = skill.name || "";
  if (descInput) descInput.value = skill.description || "";
  if (kindSelect) kindSelect.value = skill.kind || "chat";
  if (langSelect) langSelect.value = skill.language || "en";
  if (promptArea) promptArea.value = skill.prompt || "";
  if (formTitle) formTitle.textContent = "Edit skill";
  if (saveBtn) saveBtn.textContent = "Update skill";
  updateSkillPromptCount();

  // Scroll the form card into view smoothly.
  formCard?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function updateSkillPromptCount() {
  const promptArea = document.getElementById("skill-prompt");
  const countEl = document.getElementById("skill-prompt-count");
  if (!promptArea || !countEl) return;
  const len = promptArea.value.length;
  const max = 2000;
  countEl.textContent = `${len} / ${max}`;
  countEl.classList.toggle("near-limit", len >= 1600 && len < max);
  countEl.classList.toggle("at-limit", len >= max);
}

/** Runs a skill and shows the result in the result pane. */
async function runSkillById(skillId, skillName, skillKind) {
  if (!hasGeminiKey) {
    showNotice("skills-notice", "Add your Gemini API key in Settings first.", "warn");
    return;
  }

  const pane = document.getElementById("skill-result-pane");
  const loadingEl = document.getElementById("skill-result-loading");
  const outputEl = document.getElementById("skill-result-output");
  const actionsEl = document.getElementById("skill-result-actions");
  const resultName = document.getElementById("skill-result-name");
  const kindBadge = document.getElementById("skill-result-kind-badge");

  hideNotice("skills-notice");
  if (resultName) resultName.textContent = skillName || "Skill result";
  if (kindBadge) kindBadge.textContent = skillKind || "chat";
  if (outputEl) { outputEl.hidden = true; outputEl.innerHTML = ""; }
  if (actionsEl) actionsEl.hidden = true;
  if (loadingEl) loadingEl.hidden = false;
  if (pane) pane.hidden = false;

  // Scroll result pane into view
  pane?.scrollIntoView({ behavior: "smooth", block: "nearest" });

  try {
    const result = await send("RUN_SKILL", { skillId }, currentTabId);
    if (!result?.ok) {
      if (loadingEl) loadingEl.hidden = true;
      showSkillError(result?.code, result?.error);
      return;
    }
    if (loadingEl) loadingEl.hidden = true;
    if (outputEl) {
      outputEl.innerHTML = formatMarkdown(result.data?.result || "");
      outputEl.hidden = false;
    }
    if (actionsEl) actionsEl.hidden = false;
  } catch (err) {
    if (loadingEl) loadingEl.hidden = true;
    showNotice("skills-notice", err?.message || "The skill failed. Please try again.", "danger");
  }
}

function showSkillError(code, fallback) {
  const messages = {
    MISSING_KEY: "Add your Gemini API key in Settings first.",
    NO_TAB: "Open a webpage first.",
    BLOCKED_URL: "This page is blocked for safety reasons.",
    EMPTY_EXTRACTION: "Couldn't read enough text from this page. Try a different kind of skill.",
    NO_SELECTION: "Highlight some text before running a draft skill.",
    SKILL_NOT_FOUND: "That skill was not found — it may have been deleted."
  };
  const soft = code === "EMPTY_EXTRACTION" || code === "NO_SELECTION" || code === "MISSING_KEY";
  showNotice("skills-notice", messages[code] || fallback || "The skill failed.", soft ? "warn" : "danger");
}

async function deleteSkillById(skillId, skillName) {
  if (!confirm(`Delete skill "${skillName}"?`)) return;
  hideNotice("skills-notice");
  try {
    const result = await send("DELETE_SKILL", { id: skillId });
    if (result?.ok) {
      currentSkills = result.data || [];
      renderSkillsSection(currentSkills);
    } else {
      showNotice("skills-notice", result?.error || "Could not delete skill.", "danger");
    }
  } catch {
    showNotice("skills-notice", "Could not reach the service worker.", "danger");
  }
}

/**
 * Slice 4.3 — Renders the owned-origins list inside the "I own this page" card,
 * and keeps the Add/Remove button label in sync with the current tab.
 * @param {string[]} origins  Array of origin strings, e.g. ["https://mysite.com"]
 */
function renderOwnedOriginsCard(origins) {
  const list = document.getElementById("owned-origins-list");
  if (!list) return;

  list.replaceChildren();

  if (!origins || origins.length === 0) {
    const empty = document.createElement("p");
    empty.className = "lede";
    empty.textContent = "No owned origins yet.";
    list.appendChild(empty);
  } else {
    for (const origin of origins) {
      const row = document.createElement("div");
      row.className = "owned-origin-row";

      const label = document.createElement("span");
      label.className = "owned-origin-label";
      label.textContent = origin;
      label.title = origin;

      const removeBtn = document.createElement("button");
      removeBtn.className = "btn-skill-icon danger";
      removeBtn.title = `Remove ${origin}`;
      removeBtn.setAttribute("aria-label", `Remove ${origin}`);
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", async () => {
        hideNotice("agent-run-notice");
        try {
          const result = await send("REMOVE_OWNED_ORIGIN", { url: origin });
          if (result?.ok) {
            currentOwnedOrigins = Array.isArray(result.data) ? result.data : [];
            renderOwnedOriginsCard(currentOwnedOrigins);
            refreshAgentStartButton();
          }
        } catch {
          showNotice("agent-run-notice", "Could not remove origin.", "danger");
        }
      });

      row.append(label, removeBtn);
      list.appendChild(row);
    }
  }

  // Keep the Add/Remove button label in sync.
  refreshAgentStartButton();
}

/**
 * Slice 4.1 — Renders the Profile section summary card and seeds the edit form
 * inputs from the given profile object.
 * Called by refresh() every time the panel boots or storage changes.
 *
 * @param {object} profile
 */
function renderProfileSection(profile) {
  const p = profile || {};

  // ── Summary card ────────────────────────────────────────────────────
  const summaryBody = document.getElementById("profile-summary-body");
  const displayName = document.getElementById("profile-display-name");

  if (displayName) {
    displayName.textContent = p.name ? p.name : "My profile";
  }

  if (summaryBody) {
    summaryBody.replaceChildren();

    const hasData = Object.keys(p).some((k) => p[k]);
    if (!hasData) {
      const empty = document.createElement("p");
      empty.className = "lede";
      empty.textContent = "No profile saved yet. Fill in the form below and click Save.";
      summaryBody.appendChild(empty);
    } else {
      const LABELS = {
        name:          "Name",
        college:       "College",
        skills:        "Skills",
        links:         "Links",
        preferredTone: "Tone"
      };
      const grid = document.createElement("div");
      grid.className = "profile-summary-grid";

      for (const [key, label] of Object.entries(LABELS)) {
        if (!p[key]) continue;
        const row = document.createElement("div");
        row.className = "profile-summary-row";

        const keyEl = document.createElement("span");
        keyEl.className = "profile-summary-key";
        keyEl.textContent = label;

        const valEl = document.createElement("span");
        valEl.className = "profile-summary-val";
        valEl.textContent = p[key];

        row.append(keyEl, valEl);
        grid.appendChild(row);
      }
      summaryBody.appendChild(grid);
    }
  }

  // ── Edit form inputs ─────────────────────────────────────────────────
  const nameEl    = document.getElementById("panel-profile-name");
  const collegeEl = document.getElementById("panel-profile-college");
  const skillsEl  = document.getElementById("panel-profile-skills");
  const linksEl   = document.getElementById("panel-profile-links");
  const toneEl    = document.getElementById("panel-profile-tone");

  if (nameEl)    nameEl.value    = p.name          || "";
  if (collegeEl) collegeEl.value = p.college       || "";
  if (skillsEl)  skillsEl.value  = p.skills        || "";
  if (linksEl)   linksEl.value   = p.links         || "";
  if (toneEl)    toneEl.value    = p.preferredTone || "friendly and polite";
}

/**
 * Slice 3.4 — Renders the full action log into the dedicated Log section tab.
 * Mirrors the same data as the inline agent-log-list but in a richer layout
 * with goal, step count, timestamps, and decision colour coding.
 *
 * @param {Array<{step:number, proposed:object, decision:string, at:string}>} log
 */
function renderFullLog(log) {
  const host = document.getElementById("log-section-content");
  if (!host) return;

  host.replaceChildren();

  if (!log || !log.length) {
    const empty = document.createElement("p");
    empty.className = "lede";
    empty.textContent = "No agent steps have been taken yet. Run an errand on the Agent tab to see the action log here.";
    host.appendChild(empty);
    return;
  }

  // Goal + summary header
  const meta = document.createElement("div");
  meta.className = "log-meta";

  const goalText = agentState?.goal || "";
  if (goalText) {
    const goalEl = document.createElement("p");
    goalEl.className = "log-goal";
    goalEl.textContent = `Goal: ${goalText}`;
    meta.appendChild(goalEl);
  }

  const summaryEl = document.createElement("p");
  summaryEl.className = "log-summary";
  const approved = log.filter((e) => e.decision === "approved").length;
  const dryRuns = log.filter((e) => e.decision === "dry-run").length;
  const skipped = log.filter((e) => e.decision === "skipped").length;
  const parts = [`${log.length} step${log.length === 1 ? "" : "s"}`];
  if (approved) parts.push(`${approved} approved`);
  if (dryRuns) parts.push(`${dryRuns} dry-run`);
  if (skipped) parts.push(`${skipped} skipped`);
  summaryEl.textContent = parts.join(" · ");
  meta.appendChild(summaryEl);
  host.appendChild(meta);

  // Log table
  const table = document.createElement("table");
  table.className = "log-table";

  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>#</th><th>Action</th><th>Decision</th><th>Time</th></tr>";
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  for (const entry of log) {
    const tr = document.createElement("tr");
    tr.className = "log-row";

    // Step number
    const tdStep = document.createElement("td");
    tdStep.className = "log-cell log-cell-step";
    tdStep.textContent = String(entry.step);
    tr.appendChild(tdStep);

    // Action description
    const tdAction = document.createElement("td");
    tdAction.className = "log-cell log-cell-action";
    tdAction.textContent = describeLogEntry(entry);
    if (entry.proposed?.reason) {
      const reason = document.createElement("span");
      reason.className = "log-reason";
      reason.textContent = entry.proposed.reason;
      tdAction.appendChild(document.createElement("br"));
      tdAction.appendChild(reason);
    }
    tr.appendChild(tdAction);

    // Decision badge
    const tdDecision = document.createElement("td");
    tdDecision.className = "log-cell log-cell-decision";
    const badge = document.createElement("span");
    badge.className = "node-flag";
    const d = entry.decision || "unknown";
    if (d === "approved")   badge.classList.add("node-flag-approved");
    else if (d === "dry-run") badge.classList.add("node-flag-dry-run");
    else if (d === "skipped") badge.classList.add("node-flag-subtle");
    else                    badge.classList.add("node-flag-consequential");
    badge.textContent = d;
    tdDecision.appendChild(badge);
    tr.appendChild(tdDecision);

    // Timestamp
    const tdTime = document.createElement("td");
    tdTime.className = "log-cell log-cell-time";
    try {
      const d = new Date(entry.at);
      tdTime.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      tdTime.title = d.toLocaleString();
    } catch {
      tdTime.textContent = entry.at || "–";
    }
    tr.appendChild(tdTime);

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  host.appendChild(table);
}

async function runAgentCommand(type, payload) {
  if (agentBusy) return;

  agentBusy = true;
  agentConfirmArmed = false;
  hideNotice("agent-run-notice");
  renderAgentState(agentState);

  let failure = null;
  try {
    const result = await send(type, payload || {}, currentTabId);
    if (result?.data) agentState = result.data;
    if (!result?.ok) failure = { code: result?.code, error: result?.error };
  } catch {
    failure = { code: null, error: "The agent run failed. Please try again." };
  } finally {
    agentBusy = false;
    renderAgentState(agentState);
  }

  if (failure) showAgentRunError(failure.code, failure.error);
}

function startAgentRun() {
  const goalEl = document.getElementById("agent-goal");
  const goal = String(goalEl?.value || "").trim();
  if (!goal) {
    showAgentRunError("NO_GOAL");
    return;
  }
  const dryRunEl = document.getElementById("agent-dry-run");
  const dryRun = dryRunEl ? dryRunEl.checked : false;
  runAgentCommand("AGENT_START", { goal, dryRun });
}

/** Consequential actions need a second tap before they run (architecture §8.5). */
function approveAgentRun() {
  const pending = agentState?.pendingAction;
  if (!pending || pending.sensitive) return;

  if (pending.consequential && !agentConfirmArmed) {
    agentConfirmArmed = true;
    const btn = document.getElementById("btn-agent-approve");
    if (btn) btn.textContent = "Tap again to confirm";
    const warnEl = document.getElementById("agent-proposal-warn");
    if (warnEl) {
      warnEl.textContent = "This looks like Submit/Pay/Send. Tap Approve again to confirm.";
      warnEl.hidden = false;
    }
    return;
  }

  runAgentCommand("AGENT_APPROVE");
}

function skipAgentRun() {
  runAgentCommand("AGENT_SKIP");
}

function stopAgentRun() {
  runAgentCommand("AGENT_STOP");
}

/** Rebinds the panel to a session that may already be running (panel reopen / SW wake). */
async function restoreAgentState(activeTabId) {
  if (agentBusy) return;

  try {
    // Slice 3.4: AGENT_STATE_RESTORE triggers rehydration from chrome.storage
    // inside the SW before returning state, so a post-sleep panel gets the full
    // persisted session (including the pending proposal) in a single round-trip.
    const result = await send("AGENT_STATE_RESTORE", {}, activeTabId);
    if (!result?.ok) return;

    const state = result.data;
    // An agent run is bound to one tab; moving away ends it.
    if (state?.active && typeof state.tabId === "number" && state.tabId !== activeTabId) {
      const stopped = await send("AGENT_STOP", {}, activeTabId);
      renderAgentState(stopped?.data || null);
      return;
    }
    renderAgentState(state);
  } catch {
    // Leave whatever is on screen if the worker is unreachable.
  }
}

/* ==========================================================================
   INITIALIZATION & EVENT HANDLERS
   ========================================================================== */

async function refresh() {
  try {
    const win = await chrome.windows.getCurrent();
    const result = await send("GET_PANEL_BOOTSTRAP", { windowId: win.id });

    if (!result?.ok) {
      renderBanners({ hasGeminiKey: false, tab: null });
      return;
    }

    const { hasGeminiKey: keyPresent, preferredLanguage, tab } = result.data;
    hasGeminiKey = Boolean(keyPresent);

    // Slice 4.1: cache profile returned from bootstrap and re-render the profile tab.
    currentProfile = result.data.profile || {};
    renderProfileSection(currentProfile);

    // Slice 4.2: cache skills and re-render the skills tab.
    currentSkills = result.data.skills || [];
    renderSkillsSection(currentSkills);

    // Slice 4.3: cache owned origins and update the ownership card.
    currentOwnedOrigins = result.data.ownedOrigins || [];
    renderOwnedOriginsCard(currentOwnedOrigins);

    // Seed the dry-run checkbox from the user's saved default.
    const dryRunCheckbox = document.getElementById("agent-dry-run");
    if (dryRunCheckbox && !agentState?.active) {
      // Only reset the checkbox if no run is in progress (respect any mid-run toggle).
      dryRunCheckbox.checked = Boolean(result.data.dryRunDefault);
    }

    // Switching tabs mid-stream: stop the old turn before rebinding the thread.
    const nextTabId = tab?.id ?? null;
    if (chatBusy && nextTabId !== currentTabId) {
      settleInflightTurn();
    }
    // A capture belongs to one tab; drop it when the active tab changes.
    if (captureData && captureTabId !== null && captureTabId !== nextTabId) {
      resetCapture();
    }
    // Badges belong to one tab; clear them on the tab we are leaving (Slice 3.1).
    if (lastScanData && scanTabId !== null && scanTabId !== nextTabId) {
      send("CLEAR_OVERLAY", {}, scanTabId).catch(() => {});
      forgetScan();
      forgetFind();
    }
    currentTabId = nextTabId;
    lastTabInfo = tab;

    renderBanners(result.data);
    renderPageMeta(tab);
    wireBannerLinks();

    const langSelect = document.getElementById("language");
    if (preferredLanguage) {
      langSelect.value = preferredLanguage;
    }

    // Enable/disable action buttons based on tab support
    const explainBtn = document.getElementById("btn-explain-selection");
    if (explainBtn) {
      explainBtn.disabled = !tab?.supported;
      explainBtn.title = tab?.supported
        ? "Explain currently highlighted text on this page"
        : "Open an http/https webpage to use Sahayak";
    }

    const summaryBtn = document.getElementById("btn-summarise-page");
    const summaryTitle = document.getElementById("summary-card-title");
    const summaryBadge = document.getElementById("summary-card-badge");
    const summaryDesc = document.getElementById("summary-card-desc");
    const summaryBtnText = document.getElementById("btn-summarise-text");

    const isYT = Boolean(tab?.isYouTube);
    const isYTVideo = Boolean(tab?.isYouTubeVideo);

    if (isYT) {
      if (summaryTitle) summaryTitle.textContent = "YouTube Video Summary";
      if (summaryBadge) summaryBadge.textContent = "Gemini Video";
      if (summaryBtnText) summaryBtnText.textContent = "Summarise YouTube video";
      if (isYTVideo) {
        if (summaryDesc) {
          summaryDesc.textContent =
            "Sends the video link directly to Gemini video AI to generate chapter-by-chapter timestamped notes and executive summary without scraping captions.";
        }
        if (summaryBtn) {
          summaryBtn.disabled = false;
          summaryBtn.title = "Summarise this YouTube video into timestamped chapter notes & executive summary";
        }
      } else {
        if (summaryDesc) {
          summaryDesc.textContent = "Open a specific YouTube video to summarize it with timestamped chapters.";
        }
        if (summaryBtn) {
          summaryBtn.disabled = false;
          summaryBtn.title = "Open a specific video to summarize it";
        }
      }
    } else {
      if (summaryTitle) summaryTitle.textContent = "Article Summary";
      if (summaryBadge) summaryBadge.textContent = "Flash-Lite";
      if (summaryBtnText) summaryBtnText.textContent = "Summarise this page";
      if (summaryDesc) {
        summaryDesc.textContent =
          "Extracts the main article text cleanly using Mozilla Readability (excluding navigation, ads, and footers) and generates a structured summary with TL;DR, 5 key points, and next steps.";
      }
      if (summaryBtn) {
        summaryBtn.disabled = !tab?.supported;
        summaryBtn.title = tab?.supported
          ? "Summarise this article into TL;DR and 5 key points"
          : "Open an http/https webpage to use Sahayak";
      }
    }

    refreshComposer();
    refreshScreenshotButton();
    refreshScanButton();
    refreshFindButton();
    refreshAgentStartButton();
    await restoreAgentState(currentTabId);
    await loadChatThread();
  } catch (error) {
    renderBanners({ hasGeminiKey: false, tab: null });
  }
}

function initTabs() {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      switchToTab(tab.dataset.section);
    });
  });
}

function initEventListeners() {
  document.getElementById("open-settings")?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // Timestamp click handler on summary output
  const summaryOutput = document.getElementById("summary-output");
  summaryOutput?.addEventListener("click", async (event) => {
    const link = event.target.closest(".yt-timestamp-link");
    if (!link) return;

    event.preventDefault();
    const seconds = parseInt(link.dataset.seconds, 10);
    const videoId = link.dataset.videoId || lastSummaryData?.videoId;

    document.querySelectorAll(".yt-timestamp-link.is-active").forEach((el) => el.classList.remove("is-active"));
    link.classList.add("is-active");

    try {
      await send("SEEK_YOUTUBE", { seconds, videoId }, currentTabId);
    } catch (err) {
      console.error("Failed to seek YouTube tab:", err);
    }
  });

  // Switch to Summary from Chat card
  document.getElementById("btn-goto-summary")?.addEventListener("click", () => {
    switchToTab("summary");
  });

  // Selection Explanation events
  document.getElementById("btn-explain-selection")?.addEventListener("click", () => {
    explainCurrentSelection();
  });

  document.getElementById("btn-close-result")?.addEventListener("click", () => {
    document.getElementById("explain-result-pane").hidden = true;
    hideNotice("explain-notice");
    lastExplanationData = null;
  });

  // Summary events
  document.getElementById("btn-summarise-page")?.addEventListener("click", () => {
    summariseCurrentPage();
  });

  document.getElementById("btn-close-summary")?.addEventListener("click", () => {
    document.getElementById("summary-result-pane").hidden = true;
    hideNotice("summary-notice");
    lastSummaryData = null;
  });

  // Language select changed in header (Slice 1.2 & Slice 1.5)
  const langSelect = document.getElementById("language");
  langSelect?.addEventListener("change", async () => {
    const newLang = langSelect.value;
    await send("SET_LANGUAGE", { language: newLang });

    // Edge case 1.5-01: Toggle during in-flight generation
    if (isGenerating) {
      pendingLanguageChange = newLang;
      return;
    }

    // Edge case 1.5-02: Toggle with no last result: persist preference only
    const activeSection = document.querySelector(".section.is-active");
    if (activeSection?.id === "section-summary") {
      if (lastSummaryData) {
        summariseCurrentPage({
          ...lastSummaryData,
          language: newLang
        });
      }
    } else if (activeSection?.id === "section-chat") {
      if (lastExplanationData && lastExplanationData.selection) {
        explainCurrentSelection({
          ...lastExplanationData,
          language: newLang
        });
      }
    }
  });

  // Toggle button in explain result footer
  document.getElementById("btn-toggle-explain-lang")?.addEventListener("click", async () => {
    if (!lastExplanationData || isGenerating) return;
    const current = lastExplanationData.language === "hinglish" ? "hinglish" : "en";
    const next = current === "hinglish" ? "en" : "hinglish";

    langSelect.value = next;
    await send("SET_LANGUAGE", { language: next });

    explainCurrentSelection({
      ...lastExplanationData,
      language: next
    });
  });

  // Toggle button in summary result footer
  document.getElementById("btn-toggle-summary-lang")?.addEventListener("click", async () => {
    if (!lastSummaryData || isGenerating) return;
    const current = lastSummaryData.language === "hinglish" ? "hinglish" : "en";
    const next = current === "hinglish" ? "en" : "hinglish";

    langSelect.value = next;
    await send("SET_LANGUAGE", { language: next });

    summariseCurrentPage({
      ...lastSummaryData,
      language: next
    });
  });

  // Copy explain button
  const copyExplainBtn = document.getElementById("btn-copy-explanation");
  copyExplainBtn?.addEventListener("click", async () => {
    if (!lastExplanationData?.explanation) return;
    try {
      await navigator.clipboard.writeText(lastExplanationData.explanation);
      const copyText = document.getElementById("copy-btn-text");
      const original = copyText.textContent;
      copyText.textContent = "Copied!";
      setTimeout(() => {
        copyText.textContent = original;
      }, 2000);
    } catch {
      showNotice("explain-notice", "Could not copy text to clipboard.", "warn");
    }
  });

  // Copy summary button
  const copySummaryBtn = document.getElementById("btn-copy-summary");
  copySummaryBtn?.addEventListener("click", async () => {
    if (!lastSummaryData?.summary) return;
    try {
      await navigator.clipboard.writeText(lastSummaryData.summary);
      const copyText = document.getElementById("copy-summary-btn-text");
      const original = copyText.textContent;
      copyText.textContent = "Copied!";
      setTimeout(() => {
        copyText.textContent = original;
      }, 2000);
    } catch {
      showNotice("summary-notice", "Could not copy summary to clipboard.", "warn");
    }
  });

  // Grounded page chat composer (Slice 2.1)
  const composer = document.getElementById("composer");
  const promptEl = document.getElementById("prompt");

  composer?.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = promptEl?.value || "";
    if (!text.trim()) return;
    if (promptEl) promptEl.value = "";
    submitChat(text);
  });

  promptEl?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      composer?.requestSubmit();
    }
  });

  // Context-menu action result (Slice 2.2)
  document.getElementById("btn-close-action")?.addEventListener("click", () => {
    document.getElementById("action-result-pane").hidden = true;
    hideNotice("action-notice");
    lastActionData = null;
  });

  const copyActionBtn = document.getElementById("btn-copy-action");
  copyActionBtn?.addEventListener("click", async () => {
    if (!lastActionData?.text) return;
    try {
      await navigator.clipboard.writeText(lastActionData.text);
      const copyText = document.getElementById("copy-action-btn-text");
      if (!copyText) return;
      const original = copyText.textContent;
      copyText.textContent = "Copied!";
      setTimeout(() => {
        copyText.textContent = original;
      }, 2000);
    } catch {
      showNotice("action-notice", "Could not copy text to clipboard.", "warn");
    }
  });

  // Screenshot & ask (Slice 2.3)
  document.getElementById("btn-capture")?.addEventListener("click", () => {
    startCapture();
  });

  document.getElementById("btn-capture-reset")?.addEventListener("click", () => {
    resetCrop();
    refreshScreenshotButton();
  });

  const cropWrap = document.getElementById("capture-image-wrap");
  cropWrap?.addEventListener("pointerdown", handleCropPointerDown);
  cropWrap?.addEventListener("pointermove", handleCropPointerMove);
  cropWrap?.addEventListener("pointerup", handleCropPointerUp);
  cropWrap?.addEventListener("pointercancel", handleCropPointerUp);

  document.getElementById("screenshot-question")?.addEventListener("input", () => {
    refreshScreenshotButton();
  });

  document.getElementById("btn-ask-screenshot")?.addEventListener("click", () => {
    askScreenshot();
  });

  document.getElementById("btn-close-screenshot")?.addEventListener("click", () => {
    document.getElementById("screenshot-result-pane").hidden = true;
    hideNotice("capture-notice");
    lastScreenshotData = null;
  });

  const copyScreenshotBtn = document.getElementById("btn-copy-screenshot");
  copyScreenshotBtn?.addEventListener("click", async () => {
    if (!lastScreenshotData?.answer) return;
    try {
      await navigator.clipboard.writeText(lastScreenshotData.answer);
      const copyText = document.getElementById("copy-screenshot-btn-text");
      if (!copyText) return;
      const original = copyText.textContent;
      copyText.textContent = "Copied!";
      setTimeout(() => {
        copyText.textContent = original;
      }, 2000);
    } catch {
      showNotice("capture-notice", "Could not copy text to clipboard.", "warn");
    }
  });

  // Scanner and badges (Slice 3.1)
  document.getElementById("btn-scan-page")?.addEventListener("click", () => {
    scanPage();
  });

  document.getElementById("btn-clear-badges")?.addEventListener("click", () => {
    clearBadges();
  });

  // Find it for me (Slice 3.2)
  document.getElementById("btn-find-element")?.addEventListener("click", () => {
    findElementForMe();
  });

  const findInput = document.getElementById("find-question");
  findInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      findElementForMe();
    }
  });

  document.getElementById("btn-close-find")?.addEventListener("click", () => {
    forgetFind();
  });

  // Run an errand (Slice 3.3)
  document.getElementById("btn-agent-start")?.addEventListener("click", () => {
    startAgentRun();
  });

  const agentGoalInput = document.getElementById("agent-goal");
  agentGoalInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      startAgentRun();
    }
  });

  // Practice page launchers (Slice 3.5)
  document.getElementById("btn-open-form")?.addEventListener("click", () => {
    openPracticePage("test-pages/form.html");
  });
  document.getElementById("btn-open-shop")?.addEventListener("click", () => {
    openPracticePage("test-pages/shop.html");
  });

  // Owned-origins toggle (Slice 4.3)
  // The same button adds or removes the origin depending on current state.
  document.getElementById("btn-add-owned-origin")?.addEventListener("click", async () => {
    const url = lastTabInfo?.url || "";
    if (!url) return;
    hideNotice("agent-run-notice");

    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      showNotice("agent-run-notice", "Could not read the current page URL.", "danger");
      return;
    }

    const isOwned = currentOwnedOrigins.includes(origin);

    try {
      if (isOwned) {
        const result = await send("REMOVE_OWNED_ORIGIN", { url });
        if (result?.ok) {
          currentOwnedOrigins = Array.isArray(result.data) ? result.data : [];
          renderOwnedOriginsCard(currentOwnedOrigins);
          showNotice("agent-run-notice", `"${origin}" removed from owned origins.`, "warn");
          setTimeout(() => hideNotice("agent-run-notice"), 3000);
        } else {
          showNotice("agent-run-notice", result?.error || "Could not remove origin.", "danger");
        }
      } else {
        const result = await send("ADD_OWNED_ORIGIN", { url });
        if (result?.ok) {
          currentOwnedOrigins = result.origins || result.data || [];
          renderOwnedOriginsCard(currentOwnedOrigins);
          showNotice(
            "agent-run-notice",
            `"${origin}" marked as owned. You can now start the agent on this page.`,
            "warn"
          );
          setTimeout(() => hideNotice("agent-run-notice"), 4000);
        } else {
          showNotice("agent-run-notice", result?.error || "Could not add origin.", "danger");
        }
      }
    } catch {
      showNotice("agent-run-notice", "Could not reach the service worker.", "danger");
    }
  });

  document.getElementById("btn-agent-approve")?.addEventListener("click", () => {
    approveAgentRun();
  });

  document.getElementById("btn-agent-skip")?.addEventListener("click", () => {
    skipAgentRun();
  });

  document.getElementById("btn-agent-stop")?.addEventListener("click", () => {
    stopAgentRun();
  });

  document.getElementById("btn-close-agent-run")?.addEventListener("click", () => {
    forgetAgentRun();
  });

  document.getElementById("btn-close-agent")?.addEventListener("click", () => {
    hideNotice("agent-notice");
    forgetScan();
  });

  const copyAgentJsonBtn = document.getElementById("btn-copy-agent-json");
  copyAgentJsonBtn?.addEventListener("click", async () => {
    const jsonEl = document.getElementById("agent-json-preview");
    if (!jsonEl?.textContent) return;
    try {
      await navigator.clipboard.writeText(jsonEl.textContent);
      const copyText = document.getElementById("copy-agent-json-btn-text");
      if (!copyText) return;
      const original = copyText.textContent;
      copyText.textContent = "Copied!";
      setTimeout(() => {
        copyText.textContent = original;
      }, 2000);
    } catch {
      showNotice("agent-notice", "Could not copy the action map to the clipboard.", "warn");
    }
  });

  // Profile form (Slice 4.1) — inline editor inside the panel Profile tab.
  document.getElementById("panel-profile-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideNotice("profile-notice");

    const updates = {
      name:          document.getElementById("panel-profile-name")?.value.trim()    || "",
      college:       document.getElementById("panel-profile-college")?.value.trim() || "",
      skills:        document.getElementById("panel-profile-skills")?.value.trim()  || "",
      links:         document.getElementById("panel-profile-links")?.value.trim()   || "",
      preferredTone: document.getElementById("panel-profile-tone")?.value            || "friendly and polite"
    };

    try {
      const result = await send("SAVE_PROFILE", updates);
      if (result?.ok) {
        currentProfile = result.data || {};
        renderProfileSection(currentProfile);
        showNotice("profile-notice", "Profile saved.", "warn"); // reuse warn style as a soft success
        // Auto-dismiss after 2 s
        setTimeout(() => hideNotice("profile-notice"), 2000);
      } else {
        showNotice("profile-notice", result?.error || "Could not save profile.", "danger");
      }
    } catch {
      showNotice("profile-notice", "Could not reach the service worker.", "danger");
    }
  });

  document.getElementById("btn-clear-profile")?.addEventListener("click", async () => {
    hideNotice("profile-notice");
    try {
      const result = await send("CLEAR_PROFILE", {});
      if (result?.ok) {
        currentProfile = {};
        renderProfileSection(currentProfile);
        showNotice("profile-notice", "Profile cleared.", "warn");
        setTimeout(() => hideNotice("profile-notice"), 2000);
      } else {
        showNotice("profile-notice", result?.error || "Could not clear profile.", "danger");
      }
    } catch {
      showNotice("profile-notice", "Could not reach the service worker.", "danger");
    }
  });

  // ── Skills (Slice 4.2) ────────────────────────────────────────────────────

  // Skill add/edit form submit
  document.getElementById("skill-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideNotice("skills-notice");

    const id = document.getElementById("skill-edit-id")?.value.trim() || "";
    const skill = {
      id: id || undefined,
      name:        document.getElementById("skill-name")?.value.trim()        || "",
      description: document.getElementById("skill-description")?.value.trim() || "",
      kind:        document.getElementById("skill-kind")?.value                || "chat",
      language:    document.getElementById("skill-language")?.value            || "en",
      prompt:      document.getElementById("skill-prompt")?.value.trim()       || ""
    };

    try {
      const result = await send("SAVE_SKILL", skill);
      if (result?.ok) {
        currentSkills = result.data || [];
        renderSkillsSection(currentSkills);
        showNotice("skills-notice", id ? "Skill updated." : "Skill saved.", "warn");
        setTimeout(() => hideNotice("skills-notice"), 2000);
      } else {
        showNotice("skills-notice", result?.error || "Could not save skill.", "danger");
      }
    } catch {
      showNotice("skills-notice", "Could not reach the service worker.", "danger");
    }
  });

  // Cancel editing — reset to "add new" state
  document.getElementById("btn-cancel-skill")?.addEventListener("click", () => {
    resetSkillForm();
    hideNotice("skills-notice");
  });

  // Live character count on the prompt textarea
  document.getElementById("skill-prompt")?.addEventListener("input", updateSkillPromptCount);

  // Close skill result pane
  document.getElementById("btn-close-skill-result")?.addEventListener("click", () => {
    const pane = document.getElementById("skill-result-pane");
    if (pane) pane.hidden = true;
    hideNotice("skills-notice");
  });

  // Copy skill result
  document.getElementById("btn-copy-skill-result")?.addEventListener("click", async () => {
    const outputEl = document.getElementById("skill-result-output");
    const text = outputEl?.textContent?.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const label = document.getElementById("copy-skill-result-text");
      if (!label) return;
      const orig = label.textContent;
      label.textContent = "Copied!";
      setTimeout(() => { label.textContent = orig; }, 2000);
    } catch {
      showNotice("skills-notice", "Could not copy to clipboard.", "warn");
    }
  });

  // Export skills — download JSON file
  document.getElementById("btn-export-skills")?.addEventListener("click", async () => {
    hideNotice("skills-notice");
    try {
      const result = await send("EXPORT_SKILLS", {});
      if (!result?.ok || !Array.isArray(result.data)) {
        showNotice("skills-notice", result?.error || "Export failed.", "danger");
        return;
      }
      const json = JSON.stringify(result.data, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "sahayak-skills.json";
      a.click();
      URL.revokeObjectURL(url);
      showNotice("skills-notice", `Exported ${result.data.length} skill${result.data.length === 1 ? "" : "s"}.`, "warn");
      setTimeout(() => hideNotice("skills-notice"), 3000);
    } catch {
      showNotice("skills-notice", "Export failed. Please try again.", "danger");
    }
  });

  // Import skills — read JSON file and send to SW for validation + merge
  document.getElementById("skills-file-input")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    // Reset so the same file can be re-imported if needed.
    event.target.value = "";

    hideNotice("skills-notice");

    let parsed;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch {
      showNotice("skills-notice", "The file is not valid JSON. Choose a sahayak-skills.json export.", "danger");
      return;
    }

    if (!Array.isArray(parsed)) {
      showNotice("skills-notice", "The file must contain a JSON array of skills.", "danger");
      return;
    }

    try {
      const result = await send("IMPORT_SKILLS", { data: parsed });
      if (!result?.ok) {
        showNotice("skills-notice", result?.error || "Import failed.", "danger");
        return;
      }
      currentSkills = result.data || [];
      renderSkillsSection(currentSkills);
      const { imported = 0, skipped = 0 } = result;
      const msg = skipped > 0
        ? `Imported ${imported} skill${imported !== 1 ? "s" : ""} (${skipped} skipped — invalid).`
        : `Imported ${imported} skill${imported !== 1 ? "s" : ""} successfully.`;
      showNotice("skills-notice", msg, "warn");
      setTimeout(() => hideNotice("skills-notice"), 4000);
    } catch {
      showNotice("skills-notice", "Import failed. Please try again.", "danger");
    }
  });
}

initTabs();
initEventListeners();
refresh();
consumePendingAction();

// Context-menu handoff: the worker nudges an already-open panel (Slice 2.2).
// AGENT_STATE_PUSH: SW broadcasts restored session after waking from sleep (Slice 3.4).
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "CONTEXT_ACTION_PENDING") {
    consumePendingAction();
    return;
  }

  // Slice 3.4: SW woke up, restored a session from storage, and pushed the state.
  // Re-render the proposal card so the user sees the pending action without
  // needing to reopen the panel. Never auto-executes.
  if (message?.type === "AGENT_STATE_PUSH" && message.data) {
    const state = message.data;
    // Ignore if the push is for a different tab than what the panel is showing.
    if (typeof state.tabId === "number" && state.tabId !== currentTabId) return;
    if (!agentBusy) {
      renderAgentState(state);
      // If the panel is not on the Agent tab, switch to it so the user sees the proposal.
      if (state.status === "awaiting_approval") {
        switchToTab("agent");
      }
    }
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.settings || changes.preferredLanguage)) {
    refresh();
  }
  // Slice 4.1: re-render the profile tab when storage changes (e.g. saved from Options).
  if (area === "local" && changes.profile) {
    currentProfile = changes.profile.newValue || {};
    renderProfileSection(currentProfile);
  }
  // Slice 4.2: re-render the skills tab when storage changes.
  if (area === "local" && changes.skills) {
    currentSkills = changes.skills.newValue || [];
    renderSkillsSection(currentSkills);
  }
});

chrome.tabs.onActivated.addListener(() => {
  refresh();
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    refresh();
  }
});

window.addEventListener("focus", () => {
  refresh();
});
