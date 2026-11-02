import { callAiTask } from "./ai/router.js";
import {
  buildExplainPrompt,
  buildSummaryPrompt,
  buildYouTubeSummaryPrompt,
  buildTranslatePrompt,
  buildDraftPrompt,
  buildScreenshotPrompt,
  buildFindItPrompt,
  buildFindItRepairPrompt,
  getTranslateTargetLabel
} from "./ai/prompts.js";
import { buildActionMap, validateFindIt } from "./agent/schemas.js";
import { startAgent, approveStep, skipStep, stopAgent, getAgentState, restoreAgentSession } from "./agent/loop.js";
import { parseYouTubeUrl } from "./youtube.js";
import { canSendToModel, isPracticeOrigin, getOwnedOrigins } from "./safety/urls.js";
import { takePendingAction } from "./context-menu.js";
import { getProfile } from "./profile.js";
import { getSkills, seedStarterSkills } from "./skills.js";

export const MESSAGE_VERSION = 1;

const SETTINGS_KEY = "settings";

function invalidEnvelope() {
  return { ok: false, error: "Invalid message envelope" };
}

export function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function getSettings() {
  const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  return settings && typeof settings === "object" ? settings : {};
}

async function getKeyStatus() {
  const settings = await getSettings();
  const raw = settings?.geminiApiKey;
  const hasGeminiKey = typeof raw === "string" && raw.trim().length > 0;
  return { ok: true, data: { hasGeminiKey } };
}

/**
 * Finds the target tab based on explicit tabId, windowId, or current active tab.
 * @param {object} [options]
 * @param {number} [options.tabId]
 * @param {number} [options.windowId]
 * @returns {Promise<chrome.tabs.Tab | null>}
 */
export async function resolveTab({ tabId, windowId } = {}) {
  if (typeof tabId === "number") {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) return tab;
  }

  if (typeof windowId === "number") {
    const [active] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
    if (active) return active;
  }

  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  return active || null;
}

async function getPanelBootstrap({ tabId, windowId } = {}) {
  const settings = await getSettings();
  const raw = settings?.geminiApiKey;
  const hasGeminiKey = typeof raw === "string" && raw.trim().length > 0;
  const preferredLanguage = settings?.preferredLanguage === "hinglish" ? "hinglish" : "en";

  const active = await resolveTab({ tabId, windowId });
  let tab = null;

  if (active) {
    const url = active.url || "";
    const yt = parseYouTubeUrl(url);
    tab = {
      id: active.id,
      title: active.title || "Untitled page",
      url,
      supported: isHttpUrl(url),
      isPractice: isPracticeOrigin(url),
      isYouTube: yt.isYouTube,
      isYouTubeVideo: Boolean(yt.isVideo),
      videoId: yt.videoId || null,
      canonicalUrl: yt.canonicalUrl || null
    };
  }

  // Slice 4.2: seed starter skills on first panel open (no-op when list exists).
  await seedStarterSkills();

  return {
    ok: true,
    data: {
      hasGeminiKey,
      preferredLanguage,
      dryRunDefault: Boolean(settings?.dryRunDefault),
      maxSteps: (() => {
        const v = parseInt(settings?.maxSteps, 10);
        return Number.isFinite(v) && v >= 1 && v <= 50 ? v : 20;
      })(),
      profile: await getProfile(),
      skills: await getSkills(),
      ownedOrigins: await getOwnedOrigins(),
      tab
    }
  };
}

/**
 * Extracts page context (selection + Readability article text) from the tab.
 * Tries chrome.tabs.sendMessage first; falls back to scripting.executeScript.
 * @param {object} options
 * @param {number} [options.tabId]
 * @param {number} [options.windowId]
 */
export async function getPageContext({ tabId, windowId } = {}) {
  const tab = await resolveTab({ tabId, windowId });
  if (!tab) {
    return { ok: false, error: "No active browser tab found." };
  }

  if (!isHttpUrl(tab.url || "")) {
    return {
      ok: false,
      error: "Cannot read content on internal browser pages (such as chrome:// or Web Store). Please open a normal webpage."
    };
  }

  // 1. Try sending message to existing content script
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      v: MESSAGE_VERSION,
      type: "GET_PAGE_CONTEXT"
    });
    if (response?.ok && response.data) {
      return { ok: true, data: { ...response.data, tabId: tab.id } };
    }
  } catch {
    // Content script not listening or not injected yet
  }

  // 2. Fall back to dynamic script injection (inject Readability first, then reader.js)
  try {
    const [execResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["lib/Readability.js", "content/reader.js"]
    });
    if (execResult && execResult.result) {
      return { ok: true, data: { ...execResult.result, tabId: tab.id } };
    }
    return { ok: false, error: "Could not extract page context from this tab." };
  } catch (err) {
    return {
      ok: false,
      error: `Could not access page content. Please refresh the page and ensure Sahayak has permissions. (${err?.message || "Injection error"})`
    };
  }
}

/**
 * Executes AI generation with Devanagari detection and automatic one-time retry
 * for Hinglish per Edge-case 1.5-03 ("one retry; accept if still mixed").
 * Routes through callAiTask for 429 retries and Groq fallback.
 * @param {object} params
 * @param {string} params.task
 * @param {object} params.args
 * @param {object} params.settings
 * @param {string} [params.language]
 */
async function callAiWithLanguageCheck({
  task,
  args,
  settings,
  language = "en"
}) {
  const result = await callAiTask({ task, args, settings });
  if (!result.ok) return result;

  // Edge case 1.5-03: If Hinglish was requested but model output contains substantial Devanagari script
  if (language === "hinglish") {
    const devanagariMatches = (result.text || "").match(/[\u0900-\u097F]/g);
    if (devanagariMatches && devanagariMatches.length > 8) {
      const retryPrompt = `${args.prompt}\n\nCRITICAL: Do NOT write in Devanagari script (हिंदी लिपि में मत लिखिए). Respond STRICTLY in Hinglish using only the English/Latin alphabet (e.g. "Yeh explain karta hai ki...").`;
      const retryResult = await callAiTask({
        task,
        args: { ...args, prompt: retryPrompt },
        settings
      });
      if (retryResult.ok) {
        return retryResult;
      }
    }
  }

  return result;
}

/**
 * Resolves the selected text for a context action, either from the provided
 * payload or by reading the live page. Shared by Explain / Translate / Draft.
 * @param {object} options
 * @param {number} [options.tabId]
 * @param {number} [options.windowId]
 * @param {object} [options.payload]
 * @returns {Promise<{ ok: true, selection: string, title: string, url: string, heading: string|null, truncated: boolean } | { ok: false, error: string, code?: string }>}
 */
async function resolveSelectedText({ tabId, windowId, payload } = {}) {
  let context;

  if (typeof payload?.selection === "string" && payload.selection.trim().length > 0) {
    context = {
      selection: payload.selection.trim(),
      title: payload.title || "Current webpage",
      url: payload.url || "",
      heading: payload.heading || null,
      truncated: Boolean(payload.truncated)
    };
  } else {
    const contextResult = await getPageContext({ tabId, windowId });
    if (!contextResult.ok) {
      return contextResult;
    }
    context = contextResult.data;
  }

  if (context.isSensitive) {
    return {
      ok: false,
      error: "The selected text is from a password or credential field and cannot be sent to the model for security.",
      code: "SENSITIVE_FIELD"
    };
  }

  if (context.inaccessibleIframe) {
    return {
      ok: false,
      error: "The selected text is inside an inaccessible frame and could not be read.",
      code: "INACCESSIBLE_IFRAME"
    };
  }

  const selection = (context.selection || "").trim();
  if (!selection) {
    return {
      ok: false,
      error: "Please highlight some text on the webpage first.",
      code: "NO_SELECTION"
    };
  }

  return {
    ok: true,
    selection,
    title: context.title,
    url: context.url,
    heading: context.heading || null,
    truncated: Boolean(context.truncated)
  };
}

/**
 * Explains selected text from current tab or provided payload.
 * @param {object} options
 * @param {number} [options.tabId]
 * @param {number} [options.windowId]
 * @param {object} [options.payload]
 */
async function explainSelection({ tabId, windowId, payload } = {}) {
  const settings = await getSettings();
  const apiKey = settings?.geminiApiKey?.trim();

  if (!apiKey) {
    return {
      ok: false,
      error: "Set your Gemini API key in Settings before Sahayak can explain text.",
      code: "MISSING_KEY"
    };
  }

  const preferredLanguage = payload?.language || settings?.preferredLanguage || "en";

  const resolved = await resolveSelectedText({ tabId, windowId, payload });
  if (!resolved.ok) {
    return resolved;
  }

  const prompt = buildExplainPrompt({
    selection: resolved.selection,
    title: resolved.title,
    url: resolved.url,
    heading: resolved.heading,
    language: preferredLanguage
  });

  const aiResult = await callAiWithLanguageCheck({
    task: "explain",
    args: {
      prompt,
      temperature: 0.3,
      maxTokens: 1024
    },
    settings,
    language: preferredLanguage
  });

  if (!aiResult.ok) {
    return {
      ok: false,
      error: aiResult.error,
      code: aiResult.code
    };
  }

  return {
    ok: true,
    data: {
      explanation: aiResult.text,
      selection: resolved.selection,
      heading: resolved.heading,
      title: resolved.title,
      url: resolved.url,
      language: preferredLanguage,
      truncated: resolved.truncated,
      model: aiResult.model
    }
  };
}

/**
 * Translates selected text into the configured target language (Slice 2.2).
 * @param {object} options
 * @param {number} [options.tabId]
 * @param {number} [options.windowId]
 * @param {object} [options.payload]
 */
async function translateSelection({ tabId, windowId, payload } = {}) {
  const settings = await getSettings();
  const apiKey = settings?.geminiApiKey?.trim();

  if (!apiKey) {
    return {
      ok: false,
      error: "Set your Gemini API key in Settings before Sahayak can translate.",
      code: "MISSING_KEY"
    };
  }

  // Edge case 2.2-07: empty target falls back to Hindi.
  const targetLanguage = payload?.targetLanguage || settings?.translateTarget || "hi";

  const resolved = await resolveSelectedText({ tabId, windowId, payload });
  if (!resolved.ok) {
    return resolved;
  }

  const prompt = buildTranslatePrompt({
    selection: resolved.selection,
    targetLanguage,
    title: resolved.title,
    url: resolved.url
  });

  const aiResult = await callAiWithLanguageCheck({
    task: "translate",
    args: {
      prompt,
      temperature: 0.2,
      maxTokens: 1200
    },
    settings,
    // Only Hinglish needs the anti-Devanagari guard; Hindi/English keep their script.
    language: targetLanguage === "hinglish" ? "hinglish" : "en"
  });

  if (!aiResult.ok) {
    return { ok: false, error: aiResult.error, code: aiResult.code };
  }

  return {
    ok: true,
    data: {
      action: "translate",
      translation: aiResult.text,
      selection: resolved.selection,
      title: resolved.title,
      url: resolved.url,
      targetLanguage,
      targetLabel: getTranslateTargetLabel(targetLanguage),
      model: aiResult.model
    }
  };
}

/**
 * Drafts a reply to selected text using the configured tone (Slice 2.2).
 * @param {object} options
 * @param {number} [options.tabId]
 * @param {number} [options.windowId]
 * @param {object} [options.payload]
 */
async function draftReply({ tabId, windowId, payload } = {}) {
  const settings = await getSettings();
  const apiKey = settings?.geminiApiKey?.trim();

  if (!apiKey) {
    return {
      ok: false,
      error: "Set your Gemini API key in Settings before Sahayak can draft a reply.",
      code: "MISSING_KEY"
    };
  }

  // Slice 4.1: read profile and use its tone if no override in the payload.
  const profile = await getProfile();
  const tone = payload?.tone || profile?.preferredTone || "friendly and polite";

  const resolved = await resolveSelectedText({ tabId, windowId, payload });
  if (!resolved.ok) {
    return resolved;
  }

  const prompt = buildDraftPrompt({
    selection: resolved.selection,
    tone,
    title: resolved.title,
    url: resolved.url,
    profile: Object.keys(profile).length ? profile : null
  });

  const aiResult = await callAiWithLanguageCheck({
    task: "draft",
    args: {
      prompt,
      temperature: 0.5,
      maxTokens: 800
    },
    settings,
    language: "en"
  });

  if (!aiResult.ok) {
    return { ok: false, error: aiResult.error, code: aiResult.code };
  }

  return {
    ok: true,
    data: {
      action: "draft",
      draft: aiResult.text,
      selection: resolved.selection,
      title: resolved.title,
      url: resolved.url,
      tone,
      model: aiResult.model
    }
  };
}

/** Largest screenshot edge we downscale to before sending to the model. */
const MAX_SCREENSHOT_EDGE = 1536;

/**
 * Captures the visible area of the target tab for screenshot-and-ask (Slice 2.3).
 * Refuses blocked/internal/payment pages so no pixels leave the machine.
 * @param {object} options
 * @param {number} [options.tabId]
 * @param {number} [options.windowId]
 */
async function captureScreenshot({ tabId, windowId } = {}) {
  const tab = await resolveTab({ tabId, windowId });
  if (!tab) {
    return { ok: false, error: "No active browser tab found.", code: "NO_TAB" };
  }

  // Edge case 2.3-02: never capture blocked schemes or sensitive pages.
  const safety = canSendToModel(tab.url || "");
  if (!safety.ok) {
    return {
      ok: false,
      error: safety.reason || "This page cannot be captured.",
      code: "BLOCKED_URL"
    };
  }

  const winId = tab.windowId;

  // Edge case 2.3-09: capture only works on the tab that is actually visible.
  const [active] = await chrome.tabs.query({ active: true, windowId: winId }).catch(() => []);
  if (!active || active.id !== tab.id) {
    return {
      ok: false,
      error: "Bring the tab you want to capture to the front, then try again.",
      code: "TAB_NOT_VISIBLE"
    };
  }

  const win = await chrome.windows.get(winId).catch(() => null);
  if (win && win.state === "minimized") {
    return {
      ok: false,
      error: "Restore the browser window and bring it to the front to capture it.",
      code: "WINDOW_NOT_VISIBLE"
    };
  }

  try {
    // Edge case 2.3-05: captureVisibleTab returns the tab's real visible pixels (DPR aware).
    const dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: "png" });
    if (!dataUrl || typeof dataUrl !== "string") {
      return { ok: false, error: "The screenshot came back empty. Please try again.", code: "CAPTURE_EMPTY" };
    }

    return {
      ok: true,
      data: {
        dataUrl,
        url: tab.url || "",
        title: tab.title || "Current webpage",
        tabId: tab.id,
        windowId: winId,
        maxEdge: MAX_SCREENSHOT_EDGE
      }
    };
  } catch (error) {
    // Edge case 2.3-01: missing activeTab/tabs permission or a rate-limited capture.
    const message = error?.message || "";
    const friendly = /permission|activeTab/i.test(message)
      ? "Sahayak needs permission to capture this tab. Reload the page and try again."
      : /quota|MAX_CAPTURE/i.test(message)
        ? "Capturing too quickly. Wait a moment and try again."
        : "Could not capture the visible area. Please try again.";
    return { ok: false, error: friendly, code: "CAPTURE_FAILED" };
  }
}

/**
 * Sends a cropped screenshot plus a question to Gemini Flash vision (Slice 2.3).
 * @param {object} options
 * @param {number} [options.tabId]
 * @param {number} [options.windowId]
 * @param {object} [options.payload]
 */
async function askScreenshot({ tabId, windowId, payload } = {}) {
  const settings = await getSettings();
  const apiKey = settings?.geminiApiKey?.trim();

  if (!apiKey) {
    return {
      ok: false,
      error: "Set your Gemini API key in Settings before asking about a screenshot.",
      code: "MISSING_KEY"
    };
  }

  // Edge case 2.3-06: a question is required.
  const question = typeof payload?.question === "string" ? payload.question.trim() : "";
  if (!question) {
    return { ok: false, error: "Type a question about the screenshot first.", code: "NO_QUESTION" };
  }

  const imageDataUrl = payload?.imageDataUrl;
  if (typeof imageDataUrl !== "string" || !/^data:image\//i.test(imageDataUrl)) {
    return { ok: false, error: "Capture a screenshot before asking.", code: "NO_IMAGE" };
  }

  // Edge case 2.3-02 / 2.3-08: verify the page is safe and vision never falls back to text-only.
  const url = typeof payload?.url === "string" ? payload.url : "";
  const safety = canSendToModel(url);
  if (!safety.ok) {
    return {
      ok: false,
      error: safety.reason || "This page cannot be sent to the model.",
      code: "BLOCKED_URL"
    };
  }

  const prompt = buildScreenshotPrompt({ question, title, url });

  const aiResult = await callAiTask({
    task: "screenshot",
    args: {
      imageDataUrl,
      prompt,
      temperature: 0.3,
      maxTokens: 1200
    },
    settings
  });

  if (!aiResult.ok) {
    return { ok: false, error: aiResult.error, code: aiResult.code };
  }

  return {
    ok: true,
    data: {
      action: "screenshot",
      answer: aiResult.text,
      question,
      title,
      url,
      model: aiResult.model
    }
  };
}

/**
 * Summarises page article using Readability text and Gemini Flash-Lite.
 * Returns structured summary (TL;DR, 5 key points, what next).
 * @param {object} options
 * @param {number} [options.tabId]
 * @param {number} [options.windowId]
 * @param {object} [options.payload]
 */
async function summarisePage({ tabId, windowId, payload } = {}) {
  const tab = await resolveTab({ tabId, windowId });
  if (!tab) {
    return { ok: false, error: "No active browser tab found.", code: "NO_TAB" };
  }

  // Safety preflight check on URL
  const safety = canSendToModel(tab.url || "");
  if (!safety.ok) {
    return {
      ok: false,
      error: safety.reason || "This page cannot be summarized.",
      code: "SAFETY_BLOCK"
    };
  }

  const settings = await getSettings();
  const apiKey = settings?.geminiApiKey?.trim();

  if (!apiKey) {
    return {
      ok: false,
      error: "Set your Gemini API key in Settings before Sahayak can summarize pages.",
      code: "MISSING_KEY"
    };
  }

  const preferredLanguage = payload?.language || settings?.preferredLanguage || "en";

  // Edge case 1.5-05: Check if the active tab navigated away from previous summary URL
  const currentTabUrl = tab.url || "";
  const payloadUrl = payload?.canonicalUrl || payload?.url || "";
  const urlNavigated = Boolean(payloadUrl && currentTabUrl && payloadUrl !== currentTabUrl);

  const targetUrl = urlNavigated ? currentTabUrl : (payloadUrl || currentTabUrl);
  const yt = parseYouTubeUrl(targetUrl);

  if (yt.isYouTube) {
    if (!yt.isVideo) {
      return {
        ok: false,
        error: yt.reason || "This is a YouTube navigation page (channel, search, or playlist). Please open a specific video to summarize it.",
        code: "YOUTUBE_NOT_A_VIDEO"
      };
    }

    // Public YouTube video summary path (NO caption scraping)
    const videoTitle = (!urlNavigated && payload?.title) || tab.title || "YouTube Video";
    const prompt = buildYouTubeSummaryPrompt({
      videoUrl: yt.canonicalUrl,
      title: videoTitle,
      language: preferredLanguage
    });

    const aiResult = await callAiWithLanguageCheck({
      task: "youtube",
      args: {
        videoUrl: yt.canonicalUrl,
        prompt,
        temperature: 0.2,
        maxTokens: 2048
      },
      settings,
      language: preferredLanguage
    });

    if (!aiResult.ok) {
      return {
        ok: false,
        error: aiResult.error,
        code: aiResult.code
      };
    }

    return {
      ok: true,
      data: {
        summary: aiResult.text,
        title: videoTitle,
        url: yt.canonicalUrl,
        canonicalUrl: yt.canonicalUrl,
        videoId: yt.videoId,
        isYouTube: true,
        language: preferredLanguage,
        model: aiResult.model
      }
    };
  }

  // Read page context from live DOM for standard webpages
  let context = null;
  // Edge case 1.5-05: If URL changed, ignore stale cached extracted text and re-extract live DOM!
  if (!urlNavigated && typeof payload?.extractedText === "string" && payload.extractedText.trim().length > 0) {
    context = {
      title: payload.title || tab.title || "Untitled page",
      url: tab.url || "",
      extractedText: payload.extractedText.trim(),
      byline: payload.byline || null,
      siteName: payload.siteName || null,
      isTruncated: Boolean(payload.isTruncated),
      charCount: payload.extractedText.length,
      extractionMethod: payload.extractionMethod || "cache"
    };
  } else {
    const contextResult = await getPageContext({ tabId: tab.id });
    if (!contextResult.ok) {
      return contextResult;
    }
    context = contextResult.data;
  }

  if (context.isPdf) {
    return {
      ok: false,
      error: "PDF documents cannot be summarized via Readability. Try highlighting text to explain instead.",
      code: "PDF_UNSUPPORTED"
    };
  }

  // Guard: search engine results pages have no article content to summarize.
  const isSearchResultsPage =
    /^(www\.)?(google|bing|duckduckgo|yahoo|baidu|yandex)\.[a-z.]+\/search/i.test(
      new URL(tab.url || "http://x").hostname + new URL(tab.url || "http://x").pathname
    );
  if (isSearchResultsPage) {
    return {
      ok: false,
      error: "Search results pages don't have article content to summarize. Open a specific webpage and try again.",
      code: "SEARCH_PAGE_UNSUPPORTED"
    };
  }

  const articleText = (context.extractedText || "").trim();
  if (!articleText || articleText.length < 50) {
    return {
      ok: false,
      error: "Couldn’t extract an article from this page. Try highlighting text to explain instead.",
      code: "EMPTY_EXTRACTION"
    };
  }

  const prompt = buildSummaryPrompt({
    title: context.title,
    url: tab.url,
    extractedText: articleText,
    isTruncated: context.isTruncated,
    language: preferredLanguage
  });

  const aiResult = await callAiWithLanguageCheck({
    task: "summary",
    args: {
      prompt,
      temperature: 0.2,
      maxTokens: 1500
    },
    settings,
    language: preferredLanguage
  });

  if (!aiResult.ok) {
    return {
      ok: false,
      error: aiResult.error,
      code: aiResult.code
    };
  }

  return {
    ok: true,
    data: {
      summary: aiResult.text,
      title: context.title,
      url: tab.url,
      byline: context.byline,
      siteName: context.siteName,
      language: preferredLanguage,
      isTruncated: Boolean(context.isTruncated),
      charCount: context.charCount,
      extractionMethod: context.extractionMethod,
      model: aiResult.model
    }
  };
}

/**
 * Seeks YouTube tab to the specified timestamp, focusing the tab.
 * If video tab was closed, reopens YouTube with &t=SECONDS.
 * @param {object} options
 * @param {number} [options.tabId]
 * @param {number} [options.windowId]
 * @param {object} [options.payload]
 */
async function seekYouTube({ tabId, windowId, payload } = {}) {
  const seconds = typeof payload?.seconds === "number" ? Math.max(0, Math.floor(payload.seconds)) : 0;
  const videoId = payload?.videoId;

  async function trySeekInTab(tId) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tId },
        func: (sec) => {
          const video = document.querySelector("video");
          if (video) {
            video.currentTime = sec;
            video.play();
            return true;
          }
          return false;
        },
        args: [seconds]
      });
      return Boolean(res?.result);
    } catch {
      return false;
    }
  }

  // 1. Check if explicit or active tab is on YouTube
  const targetTab = await resolveTab({ tabId, windowId });
  if (targetTab && targetTab.url) {
    const yt = parseYouTubeUrl(targetTab.url);
    if (yt.isYouTube && (!videoId || yt.videoId === videoId)) {
      const sought = await trySeekInTab(targetTab.id);
      if (sought) {
        await chrome.tabs.update(targetTab.id, { active: true }).catch(() => {});
        if (targetTab.windowId) {
          await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
        }
        return { ok: true, data: { sought: true, seconds } };
      }
    }
  }

  // 2. Look for any existing YouTube tab matching videoId
  if (videoId) {
    const matchingTabs = await chrome.tabs.query({ url: "*://*.youtube.com/*" }).catch(() => []);
    for (const t of matchingTabs) {
      const parsed = parseYouTubeUrl(t.url || "");
      if (parsed.videoId === videoId) {
        const sought = await trySeekInTab(t.id);
        if (sought) {
          await chrome.tabs.update(t.id, { active: true }).catch(() => {});
          if (t.windowId) {
            await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
          }
          return { ok: true, data: { sought: true, seconds } };
        }
      }
    }
  }

  // 3. Fallback: navigate target tab or create new tab with &t=
  const fallbackUrl = videoId
    ? `https://www.youtube.com/watch?v=${videoId}&t=${seconds}s`
    : payload?.url || "https://www.youtube.com";

  if (targetTab && targetTab.id) {
    await chrome.tabs.update(targetTab.id, { url: fallbackUrl, active: true }).catch(() => {});
    if (targetTab.windowId) {
      await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
    }
  } else {
    await chrome.tabs.create({ url: fallbackUrl, active: true }).catch(() => {});
  }

  return { ok: true, data: { opened: true, seconds, url: fallbackUrl } };
}

/**
 * Asks the tab's content script for a fresh scan, injecting it on demand
 * when the page loaded before the extension did.
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<{ ok: true, data: object } | { ok: false, code: string, error: string }>}
 */
export async function requestScanFromTab(tab) {
  async function request() {
    try {
      return await chrome.tabs.sendMessage(tab.id, {
        v: MESSAGE_VERSION,
        type: "SCAN_PAGE"
      });
    } catch {
      return null;
    }
  }

  let response = await request();

  if (!response?.ok) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/overlay.js", "content/scanner.js", "content/executor.js"]
      });
      response = await request();
    } catch (err) {
      return {
        ok: false,
        code: "SCAN_FAILED",
        error: `Could not scan this page. Please reload it and try again. (${err?.message || "Injection error"})`
      };
    }
  }

  if (!response?.ok || !response.data) {
    return {
      ok: false,
      code: "SCAN_FAILED",
      error: response?.error || "Could not scan this page."
    };
  }

  return { ok: true, data: response.data };
}

/**
 * Runs the interactive-element scan in the target tab (Slice 3.1).
 * @param {object} options
 * @param {number} [options.tabId]
 * @param {number} [options.windowId]
 */
async function scanPage({ tabId, windowId } = {}) {
  const tab = await resolveTab({ tabId, windowId });
  if (!tab) {
    return { ok: false, error: "No active browser tab found.", code: "NO_TAB" };
  }

  if (!isHttpUrl(tab.url || "")) {
    return {
      ok: false,
      error: "Sahayak can only scan normal webpages (http/https).",
      code: "UNSUPPORTED_PAGE"
    };
  }

  const safety = canSendToModel(tab.url || "");
  if (!safety.ok) {
    return {
      ok: false,
      error: safety.reason || "This page cannot be scanned.",
      code: "BLOCKED_URL"
    };
  }

  const scanned = await requestScanFromTab(tab);
  if (!scanned.ok) return scanned;

  return { ok: true, data: { ...scanned.data, tabId: tab.id } };
}

/**
 * Removes the numbered badges from the target tab (Slice 3.1).
 * @param {object} options
 * @param {number} [options.tabId]
 * @param {number} [options.windowId]
 */
async function clearOverlay({ tabId, windowId } = {}) {
  const tab = await resolveTab({ tabId, windowId });
  if (!tab || !isHttpUrl(tab.url || "")) {
    return { ok: true, data: { cleared: false } };
  }

  try {
    await chrome.tabs.sendMessage(tab.id, {
      v: MESSAGE_VERSION,
      type: "CLEAR_OVERLAY"
    });
  } catch {
    // Nothing injected means nothing to clear.
  }

  return { ok: true, data: { cleared: true } };
}

/**
 * Rings one numbered element without ever clicking it (Slice 3.2).
 * @param {chrome.tabs.Tab} tab
 * @param {number} n
 * @param {number} scanGeneration
 */
export async function highlightElement(tab, n, scanGeneration) {
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      v: MESSAGE_VERSION,
      type: "HIGHLIGHT_ELEMENT",
      payload: { n, scanGeneration }
    });
    if (response?.ok) return { ok: true };
    return {
      ok: false,
      code: response?.code || "HIGHLIGHT_FAILED",
      error: response?.error || "Could not highlight that element."
    };
  } catch (err) {
    return {
      ok: false,
      code: "HIGHLIGHT_FAILED",
      error: err?.message || "Could not reach the page."
    };
  }
}

/**
 * Asks the model which numbered element matches the request.
 * Validates strictly and repairs once (edge cases 3.2-02, 3.2-05).
 * @param {object} params
 * @param {string} params.question
 * @param {object} params.scan
 * @param {object} params.settings
 */
async function askFindIt({ question, scan, settings }) {
  const actionMap = buildActionMap(scan);

  const call = (prompt) =>
    callAiTask({
      task: "find",
      args: { prompt, temperature: 0.1, maxTokens: 400 },
      settings
    });

  let result = await call(buildFindItPrompt({ question, actionMap }));
  if (!result.ok) {
    return { ok: false, code: result.code || "AI_FAILED", error: result.error };
  }

  let validation = validateFindIt(result.text, { nodeCount: scan.nodes.length });

  if (!validation.ok) {
    const repaired = await call(
      buildFindItRepairPrompt({
        question,
        actionMap,
        previous: result.text,
        error: validation.error
      })
    );
    if (!repaired.ok) {
      return { ok: false, code: repaired.code || "AI_FAILED", error: repaired.error };
    }

    validation = validateFindIt(repaired.text, { nodeCount: scan.nodes.length });
    if (!validation.ok) {
      return {
        ok: false,
        code: "NOT_FOUND",
        error: "Sahayak could not identify that element. Try describing it differently."
      };
    }
    result = repaired;
  }

  const { n, confidence, reason, clarification } = validation.data;
  return {
    ok: true,
    needsRescan: false,
    n,
    confidence,
    reason,
    clarification,
    node: n === null ? null : scan.nodes.find((node) => node.n === n) || null,
    model: result.model
  };
}

/**
 * Natural language "Find It for Me" (Slice 3.2).
 * Scans, asks the model for one element number, and highlights it. Never clicks.
 * @param {object} options
 * @param {number} [options.tabId]
 * @param {number} [options.windowId]
 * @param {{ question?: string }} [options.payload]
 */
async function findElement({ tabId, windowId, payload } = {}) {
  const question = String(payload?.question || "").trim();
  if (!question) {
    return {
      ok: false,
      code: "NO_QUESTION",
      error: "Describe what you want Sahayak to find."
    };
  }

  const tab = await resolveTab({ tabId, windowId });
  if (!tab) {
    return { ok: false, error: "No active browser tab found.", code: "NO_TAB" };
  }

  if (!isHttpUrl(tab.url || "")) {
    return {
      ok: false,
      code: "UNSUPPORTED_PAGE",
      error: "Sahayak can only find elements on normal webpages (http/https)."
    };
  }

  const safety = canSendToModel(tab.url || "");
  if (!safety.ok) {
    return {
      ok: false,
      code: "BLOCKED_URL",
      error: safety.reason || "This page cannot be used for finding elements."
    };
  }

  const settings = await getSettings();

  // One rescan is allowed when the DOM moves under us (edge case 3.2-08).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const scanned = await requestScanFromTab(tab);
    if (!scanned.ok) return scanned;

    const scan = scanned.data;
    if (!Array.isArray(scan.nodes) || scan.nodes.length === 0) {
      return {
        ok: false,
        code: "NO_ELEMENTS",
        error: "Sahayak found no interactive elements on this page."
      };
    }

    const answer = await askFindIt({ question, scan, settings });
    if (!answer.ok) return answer;

    // The model asked for clarification, or says the element is not on the page.
    if (answer.needsRescan) continue;

    if (answer.clarification) {
      return {
        ok: true,
        data: {
          action: "find",
          matched: false,
          n: null,
          confidence: answer.confidence,
          reason: answer.reason,
          scanGeneration: scan.scanGeneration,
          node: null,
          model: answer.model,
          tabId: tab.id
        }
      };
    }

    if (!answer.node) continue;

    const highlighted = await highlightElement(tab, answer.n, scan.scanGeneration);
    if (highlighted.ok) {
      return {
        ok: true,
        data: {
          action: "find",
          matched: true,
          n: answer.n,
          confidence: answer.confidence,
          reason: answer.reason,
          scanGeneration: scan.scanGeneration,
          node: answer.node,
          model: answer.model,
          tabId: tab.id
        }
      };
    }

    if (highlighted.code === "STALE_SCAN" || highlighted.code === "NODE_GONE") {
      continue;
    }

    return {
      ok: false,
      code: "HIGHLIGHT_FAILED",
      error: highlighted.error
    };
  }

  return {
    ok: false,
    code: "STALE_SCAN",
    error: "The page kept changing while Sahayak was looking. Rescan and try again."
  };
}

/**
 * Slice 4.2 — Runs a saved skill against the current page context.
 *
 * skill.kind routing:
 *  - "summarise"  → extract page text → buildSummaryPrompt + skill.prompt appended
 *  - "draft"      → resolve selected text → buildDraftPrompt + skill.prompt appended
 *  - "chat"       → extract page text → system instruction + skill.prompt as user turn
 *  - "agent"      → falls back to "chat" (full agent kind is Phase 4+ work)
 *
 * Profile is injected where available, matching the existing per-feature behaviour.
 * Safety: canSendToModel gates the URL before any page content leaves the machine.
 *
 * @param {object} options
 * @param {number} [options.tabId]
 * @param {number} [options.windowId]
 * @param {{ skillId: string }} [options.payload]
 */
async function runSkill({ tabId, windowId, payload } = {}) {
  const settings = await getSettings();
  const apiKey = settings?.geminiApiKey?.trim();
  if (!apiKey) {
    return { ok: false, code: "MISSING_KEY", error: "Set your Gemini API key in Settings before running a skill." };
  }

  const skillId = payload?.skillId;
  if (!skillId) {
    return { ok: false, code: "NO_SKILL", error: "No skill id provided." };
  }

  const skills = await getSkills();
  const skill = skills.find((s) => s.id === skillId);
  if (!skill) {
    return { ok: false, code: "SKILL_NOT_FOUND", error: "That skill was not found. It may have been deleted." };
  }

  const tab = await resolveTab({ tabId, windowId });
  if (!tab) {
    return { ok: false, code: "NO_TAB", error: "No active browser tab found." };
  }

  const safety = canSendToModel(tab.url || "");
  if (!safety.ok) {
    return { ok: false, code: "BLOCKED_URL", error: safety.reason || "This page cannot be sent to the model." };
  }

  const language = skill.language === "hinglish" ? "hinglish" : (settings?.preferredLanguage === "hinglish" ? "hinglish" : "en");
  const profile = await getProfile();
  const kind = skill.kind || "chat";

  // ── summarise kind ────────────────────────────────────────────────────────
  if (kind === "summarise") {
    const contextResult = await getPageContext({ tabId: tab.id });
    if (!contextResult.ok) return contextResult;
    const context = contextResult.data;

    if (context.isPdf) {
      return { ok: false, code: "PDF_UNSUPPORTED", error: "PDF documents cannot be summarised with this skill." };
    }

    const articleText = (context.extractedText || "").trim();
    if (!articleText || articleText.length < 50) {
      return { ok: false, code: "EMPTY_EXTRACTION", error: "Couldn't extract enough text from this page. Try a chat skill instead." };
    }

    // Append the skill's custom prompt to the standard summary prompt.
    const basePrompt = buildSummaryPrompt({
      title: context.title,
      url: tab.url,
      extractedText: articleText,
      isTruncated: context.isTruncated,
      language
    });
    const fullPrompt = `${basePrompt}\n\nAdditional instruction: ${skill.prompt}`;

    const aiResult = await callAiWithLanguageCheck({
      task: "summary",
      args: { prompt: fullPrompt, temperature: 0.2, maxTokens: 1800 },
      settings,
      language
    });
    if (!aiResult.ok) return { ok: false, error: aiResult.error, code: aiResult.code };

    return {
      ok: true,
      data: {
        skillId, skillName: skill.name, kind,
        result: aiResult.text,
        title: context.title,
        url: tab.url,
        language,
        model: aiResult.model
      }
    };
  }

  // ── draft kind ────────────────────────────────────────────────────────────
  if (kind === "draft") {
    const resolved = await resolveSelectedText({ tabId: tab.id, windowId });
    if (!resolved.ok) {
      return { ok: false, code: resolved.code || "NO_SELECTION", error: resolved.error || "Highlight some text first." };
    }

    const tone = profile?.preferredTone || "friendly and polite";
    const prompt = buildDraftPrompt({
      selection: resolved.selection,
      tone: `${tone} — ${skill.prompt}`,
      title: resolved.title,
      url: resolved.url,
      profile: Object.keys(profile).length ? profile : null
    });

    const aiResult = await callAiWithLanguageCheck({
      task: "draft",
      args: { prompt, temperature: 0.5, maxTokens: 800 },
      settings,
      language
    });
    if (!aiResult.ok) return { ok: false, error: aiResult.error, code: aiResult.code };

    return {
      ok: true,
      data: {
        skillId, skillName: skill.name, kind,
        result: aiResult.text,
        title: resolved.title,
        url: resolved.url,
        language,
        model: aiResult.model
      }
    };
  }

  // ── chat / agent kind (agent falls back to chat for now) ──────────────────
  const { buildChatSystemInstruction, buildChatContextBlock } = await import("./ai/prompts.js");

  const contextResult = await getPageContext({ tabId: tab.id });
  if (!contextResult.ok) return contextResult;
  const context = contextResult.data;

  const MAX_CONTEXT_CHARS = 28000;
  const extractedText = (context.extractedText || "").trim();

  const profileForChat = Object.keys(profile).length ? profile : null;
  const systemInstruction =
    `${buildChatSystemInstruction(language, profileForChat)}\n\n${buildChatContextBlock({
      title: context.title,
      url: context.url,
      extractedText: extractedText.slice(0, MAX_CONTEXT_CHARS),
      isTruncated: Boolean(context.isTruncated),
      selection: context.selection
    })}`;

  const contents = [{ role: "user", parts: [{ text: skill.prompt }] }];

  const aiResult = await callAiTask({
    task: "chat",
    args: { systemInstruction, contents, temperature: 0.6, maxTokens: 1500 },
    settings
  });
  if (!aiResult.ok) return { ok: false, error: aiResult.error, code: aiResult.code };

  return {
    ok: true,
    data: {
      skillId, skillName: skill.name, kind,
      result: aiResult.text,
      title: context.title,
      url: context.url,
      language,
      model: aiResult.model
    }
  };
}

/**
 * Typed envelope router. Unknown types fail closed; never throws.
 * @param {unknown} message
 * @param {chrome.runtime.MessageSender} _sender
 */
export async function handleMessage(message, _sender) {
  if (!message || typeof message !== "object") {
    return invalidEnvelope();
  }

  const envelope = /** @type {{ v?: number, type?: string, requestId?: string, tabId?: number, payload?: any }} */ (
    message
  );

  if (envelope.v !== MESSAGE_VERSION || typeof envelope.type !== "string") {
    return invalidEnvelope();
  }

  switch (envelope.type) {
    case "PING":
      return { ok: true, data: { pong: true } };

    case "GET_KEY_STATUS":
      return getKeyStatus();

    case "GET_PANEL_BOOTSTRAP":
      return getPanelBootstrap({
        tabId: envelope.tabId,
        windowId: envelope.payload?.windowId
      });

    case "GET_PAGE_CONTEXT":
      return getPageContext({
        tabId: envelope.tabId,
        windowId: envelope.payload?.windowId
      });

    case "GET_CHAT_THREAD": {
      const tab = await resolveTab({
        tabId: envelope.tabId,
        windowId: envelope.payload?.windowId
      });
      if (!tab || !isHttpUrl(tab.url || "")) {
        return { ok: true, data: { url: tab?.url || "", turns: [], contextChanged: false } };
      }
      return { ok: true, data: await getThreadEntry(tab.id, tab.url || "") };
    }

    case "EXPLAIN_SELECTION":
      return explainSelection({
        tabId: envelope.tabId,
        windowId: envelope.payload?.windowId,
        payload: envelope.payload
      });

    case "GET_PENDING_CONTEXT_ACTION":
      return { ok: true, data: await takePendingAction() };

    case "CONTEXT_ACTION": {
      const action = envelope.payload?.action;
      const args = {
        tabId: envelope.tabId,
        windowId: envelope.payload?.windowId,
        payload: envelope.payload
      };
      if (action === "explain") return explainSelection(args);
      if (action === "translate") return translateSelection(args);
      if (action === "draft") return draftReply(args);
      return { ok: false, error: `Unknown context action: ${action}` };
    }

    case "CAPTURE_SCREENSHOT":
      return captureScreenshot({
        tabId: envelope.tabId,
        windowId: envelope.payload?.windowId
      });

    case "SCREENSHOT_ASK":
      return askScreenshot({
        tabId: envelope.tabId,
        windowId: envelope.payload?.windowId,
        payload: envelope.payload
      });

    case "SUMMARISE_PAGE":
      return summarisePage({
        tabId: envelope.tabId,
        windowId: envelope.payload?.windowId,
        payload: envelope.payload
      });

    case "SEEK_YOUTUBE":
      return seekYouTube({
        tabId: envelope.tabId,
        windowId: envelope.payload?.windowId,
        payload: envelope.payload
      });

    case "SCAN_PAGE":
      return scanPage({
        tabId: envelope.tabId,
        windowId: envelope.payload?.windowId
      });

    case "CLEAR_OVERLAY":
      return clearOverlay({
        tabId: envelope.tabId,
        windowId: envelope.payload?.windowId
      });

    case "FIND_ELEMENT":
      return findElement({
        tabId: envelope.tabId,
        windowId: envelope.payload?.windowId,
        payload: envelope.payload
      });

    case "AGENT_START":
      return startAgent({
        tabId: envelope.tabId,
        windowId: envelope.payload?.windowId,
        payload: envelope.payload
      });

    case "AGENT_APPROVE":
      return approveStep();

    case "AGENT_SKIP":
      return skipStep();

    case "AGENT_STOP":
      return stopAgent({ tabId: envelope.tabId });

    case "AGENT_STATE":
      return { ok: true, data: getAgentState() };

    // Slice 3.4: panel calls this on open after a SW wake to rehydrate the
    // in-memory session from storage, then get the restored state back in one
    // round-trip. Never auto-executes any pending action.
    case "AGENT_STATE_RESTORE":
      return restoreAgentSession();

    case "SET_LANGUAGE": {
      const language = envelope.payload?.language === "hinglish" ? "hinglish" : "en";
      const settings = await getSettings();
      await chrome.storage.local.set({
        [SETTINGS_KEY]: {
          ...settings,
          preferredLanguage: language
        }
      });
      return { ok: true, data: { preferredLanguage: language } };
    }

    // Slice 4.1 — Profile read/write over the message bus.
    case "GET_PROFILE":
      return { ok: true, data: await getProfile() };

    case "SAVE_PROFILE": {
      const { saveProfile: save } = await import("./profile.js");
      const saved = await save(envelope.payload || {});
      return { ok: true, data: saved };
    }

    case "CLEAR_PROFILE": {
      const { clearProfile } = await import("./profile.js");
      await clearProfile();
      return { ok: true, data: {} };
    }

    // Slice 4.2 — Skills read/write/run over the message bus.
    case "GET_SKILLS":
      return { ok: true, data: await getSkills() };

    case "SAVE_SKILL": {
      const { saveSkill } = await import("./skills.js");
      return saveSkill(envelope.payload || {});
    }

    case "DELETE_SKILL": {
      const { deleteSkill } = await import("./skills.js");
      const updated = await deleteSkill(envelope.payload?.id || "");
      return { ok: true, data: updated };
    }

    case "IMPORT_SKILLS": {
      const { importSkills } = await import("./skills.js");
      return importSkills(envelope.payload?.data);
    }

    case "EXPORT_SKILLS":
      return { ok: true, data: await getSkills() };

    case "RUN_SKILL":
      return runSkill({
        tabId: envelope.tabId,
        windowId: envelope.payload?.windowId,
        payload: envelope.payload
      });

    // Slice 4.3 — Owned-origins management.
    case "GET_OWNED_ORIGINS":
      return { ok: true, data: await getOwnedOrigins() };

    case "ADD_OWNED_ORIGIN": {
      const { addOwnedOrigin } = await import("./safety/urls.js");
      return addOwnedOrigin(envelope.payload?.url || "");
    }

    case "REMOVE_OWNED_ORIGIN": {
      const { removeOwnedOrigin } = await import("./safety/urls.js");
      const updated = await removeOwnedOrigin(envelope.payload?.url || "");
      return { ok: true, data: updated };
    }

    default:
      return { ok: false, error: `Unknown message type: ${envelope.type}` };
  }
}
