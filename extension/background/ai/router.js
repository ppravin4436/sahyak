/**
 * AI Task Router (Slice 2.4).
 * Handles model selection, retries with backoff, and provider fallback.
 */

import { generateText, generateChat, streamChat, generateVideoContent, generateVisionContent, DEFAULT_MODEL, FALLBACK_MODEL } from "./gemini.js";
import { generateGroqText } from "./groq.js";

const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 2000, 4000];

/**
 * Executes an AI task with retry and fallback logic.
 * @param {object} params
 * @param {string} params.task 'explain' | 'translate' | 'draft' | 'summary' | 'chat' | 'screenshot' | 'youtube'
 * @param {object} params.args Arguments for the specific task function
 * @param {object} params.settings User settings (API keys, etc.)
 * @param {(delta: string) => void} [params.onDelta] For streaming chat
 * @param {AbortSignal} [params.signal] For cancellation
 * @returns {Promise<{ ok: true, text: string, model: string } | { ok: false, error: string, code?: string }>}
 */
export async function callAiTask({ task, args, settings, onDelta, signal }) {
  const isVisionTask = task === 'screenshot' || task === 'youtube';
  const isStreamTask = task === 'chat' && typeof onDelta === 'function';
  
  const geminiKey = settings?.geminiApiKey;
  const groqKey = settings?.groqApiKey;

  // Vision tasks use Flash and don't fallback to Groq
  const primaryModel = isVisionTask ? FALLBACK_MODEL : DEFAULT_MODEL;

  let lastResult = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS[attempt - 1]));
    }

    try {
      if (task === 'chat') {
        if (isStreamTask) {
          lastResult = await streamChat({ ...args, apiKey: geminiKey, model: primaryModel, onDelta, signal });
        } else {
          lastResult = await generateChat({ ...args, apiKey: geminiKey, model: primaryModel });
        }
      } else if (task === 'youtube') {
        lastResult = await generateVideoContent({ ...args, apiKey: geminiKey, model: primaryModel });
      } else if (task === 'screenshot') {
        lastResult = await generateVisionContent({ ...args, apiKey: geminiKey, model: primaryModel });
      } else {
        // Text tasks: explain, translate, draft, summary
        lastResult = await generateText({ ...args, apiKey: geminiKey, model: primaryModel });
      }

      if (lastResult.ok) return lastResult;

      // Only retry on rate limits (429) or server errors (500+)
      if (lastResult.code !== 'RATE_LIMIT' && lastResult.code !== 'SERVER_ERROR') {
        break;
      }
    } catch (error) {
      lastResult = { ok: false, error: error.message, code: 'UNKNOWN_ERROR' };
      break;
    }
  }

  // Fallback to Groq for text-only tasks if Gemini failed and Groq key exists
  if (!lastResult.ok && !isVisionTask && !isStreamTask && groqKey) {
    const groqResult = await generateGroqText({
      prompt: args.prompt || args.contents?.[args.contents.length - 1]?.parts?.[0]?.text,
      apiKey: groqKey,
      temperature: args.temperature,
      maxTokens: args.maxTokens
    });
    if (groqResult.ok) return groqResult;
  }

  return lastResult;
}
