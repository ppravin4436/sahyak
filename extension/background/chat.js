/**
 * Grounded page chat orchestration (Slice 2.1).
 * Handles CHAT_TURN over a long-lived port, streams CHAT_DELTA chunks,
 * aborts in-flight work on cancel/disconnect, and persists the thread per tab.
 */

import { callAiTask } from "./ai/router.js";
import { buildChatContextBlock, buildChatSystemInstruction } from "./ai/prompts.js";
import { canSendToModel } from "./safety/urls.js";
import { getPageContext, getSettings, isHttpUrl, resolveTab } from "./messages.js";
import { readThreads, trimTurns, writeThreads } from "./chat-store.js";
import { getProfile } from "./profile.js";

// Edge case 2.1-08: cap a pasted message so it cannot blow the token budget.
const MAX_QUESTION_CHARS = 4000;
const MAX_CONTEXT_CHARS = 28000;

/** @type {Map<chrome.runtime.Port, { controller: AbortController, requestId: string }>} */
const inflight = new Map();

function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // Port already closed (e.g. panel closed mid-stream).
  }
}

function abortInflight(port) {
  const current = inflight.get(port);
  if (current) {
    current.controller.abort();
    inflight.delete(port);
  }
}

/**
 * Registers listeners for a chat port. Keeps at most one in-flight turn per port.
 * @param {chrome.runtime.Port} port
 */
export function handleChatPort(port) {
  port.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return;

    if (message.type === "CHAT_TURN") {
      runTurn(port, message).catch(() => {});
    } else if (message.type === "CHAT_CANCEL") {
      abortInflight(port);
    }
  });

  // Edge case 2.1-06: panel closed mid-stream — abort the fetch, no orphan writes.
  port.onDisconnect.addListener(() => {
    abortInflight(port);
  });
}

async function runTurn(port, { requestId, tabId, payload }) {
  // Edge case 2.1-05: a second message aborts the first stream.
  abortInflight(port);
  const controller = new AbortController();
  inflight.set(port, { controller, requestId });

  try {
    const question = typeof payload?.message === "string" ? payload.message.trim() : "";
    if (!question) {
      safePost(port, {
        type: "CHAT_DONE",
        requestId,
        ok: false,
        code: "EMPTY_MESSAGE",
        error: "Type a question first."
      });
      return;
    }

    const settings = await getSettings();
    const apiKey = settings?.geminiApiKey?.trim();
    if (!apiKey) {
      safePost(port, {
        type: "CHAT_DONE",
        requestId,
        ok: false,
        code: "MISSING_KEY",
        error: "Set your Gemini API key in Settings before Sahayak can chat."
      });
      return;
    }

    const tab = await resolveTab({ tabId });
    if (!tab || !isHttpUrl(tab.url || "")) {
      safePost(port, {
        type: "CHAT_DONE",
        requestId,
        ok: false,
        code: "UNSUPPORTED_PAGE",
        error: "Open a normal http/https webpage to chat about it."
      });
      return;
    }

    const safety = canSendToModel(tab.url || "");
    if (!safety.ok) {
      safePost(port, {
        type: "CHAT_DONE",
        requestId,
        ok: false,
        code: "SAFETY_BLOCK",
        error: safety.reason || "This page cannot be sent to the model."
      });
      return;
    }

    const contextResult = await getPageContext({ tabId: tab.id });
    if (!contextResult.ok) {
      safePost(port, {
        type: "CHAT_DONE",
        requestId,
        ok: false,
        code: "CONTEXT_FAILED",
        error: contextResult.error
      });
      return;
    }

    const context = contextResult.data;
    const extractedText = (context.extractedText || "").trim();
    if ((!extractedText || extractedText.length < 50) && !context.selection) {
      safePost(port, {
        type: "CHAT_DONE",
        requestId,
        ok: false,
        code: "EMPTY_EXTRACTION",
        error: "Couldn't read enough text from this page to answer questions about it. Try highlighting text to explain instead."
      });
      return;
    }

    // Load the thread, resetting it when the page changed (Edge case 2.1-03).
    const threads = await readThreads();
    const key = String(tab.id);
    const existing = threads[key];
    const samePage = Boolean(existing && existing.url === context.url);
    const contextChanged = Boolean(existing && !samePage && existing.turns?.length);

    safePost(port, {
      type: "CHAT_CONTEXT",
      requestId,
      contextChanged,
      pageTitle: context.title,
      pageUrl: context.url
    });

    const turns = samePage ? existing.turns || [] : [];
    const cappedQuestion = question.length > MAX_QUESTION_CHARS ? question.slice(0, MAX_QUESTION_CHARS) : question;
    const language = settings?.preferredLanguage === "hinglish" ? "hinglish" : "en";

    // Slice 4.1: personalise the system instruction with the user's saved profile.
    const profile = await getProfile();
    const profileForChat = Object.keys(profile).length ? profile : null;

    const systemInstruction = `${buildChatSystemInstruction(language, profileForChat)}\n\n${buildChatContextBlock({
      title: context.title,
      url: context.url,
      extractedText: extractedText.slice(0, MAX_CONTEXT_CHARS),
      isTruncated: Boolean(context.isTruncated),
      selection: context.selection
    })}`;

    const contents = trimTurns(turns).map((turn) => ({
      role: turn.role === "user" ? "user" : "model",
      parts: [{ text: turn.text }]
    }));
    contents.push({ role: "user", parts: [{ text: cappedQuestion }] });

    let result;
    try {
      result = await callAiTask({
        task: "chat",
        args: {
          systemInstruction,
          contents,
          temperature: 0.7, // Chat temperature
          maxTokens: 2048
        },
        settings,
        onDelta: (delta) => safePost(port, { type: "CHAT_DELTA", requestId, delta }),
        signal: controller.signal
      });
    } catch (error) {
      result = { ok: false, error: error?.message || "Chat failed.", code: "CHAT_ERROR" };
    }

    if (!result.ok) {
      if (result.code === "ABORTED") return;
      safePost(port, {
        type: "CHAT_DONE",
        requestId,
        ok: false,
        code: result.code,
        error: result.error
      });
      return;
    }

    const now = new Date().toISOString();
    const updatedTurns = trimTurns([
      ...turns,
      { role: "user", text: cappedQuestion, at: now },
      { role: "model", text: result.text, at: now }
    ]);
    threads[key] = { url: context.url, turns: updatedTurns };
    await writeThreads(threads);

    safePost(port, {
      type: "CHAT_DONE",
      requestId,
      ok: true,
      data: {
        text: result.text,
        contextChanged,
        pageTitle: context.title,
        pageUrl: context.url
      }
    });
  } catch (error) {
    safePost(port, {
      type: "CHAT_DONE",
      requestId,
      ok: false,
      code: "CHAT_ERROR",
      error: error?.message || "Chat failed unexpectedly."
    });
  } finally {
    const current = inflight.get(port);
    if (current && current.requestId === requestId) {
      inflight.delete(port);
    }
  }
}
