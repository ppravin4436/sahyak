/**
 * Gemini REST client for Manifest V3 background service worker.
 * Uses generateContent REST endpoint. Never leaks API keys in errors or logs.
 */

export const DEFAULT_MODEL = "gemini-3.5-flash-lite";
export const FALLBACK_MODEL = "gemini-3.8-flash";

const API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Cleanly format errors without leaking API keys.
 * @param {Response} response
 * @param {unknown} data
 * @returns {{ error: string, code: string }}
 */
function parseApiError(response, data) {
  const status = response.status;
  const apiMessage = data?.error?.message || "";

  if (status === 400 && /API_KEY_INVALID|key not valid/i.test(apiMessage)) {
    return {
      error: "Invalid Gemini API key. Please verify your API key in Settings.",
      code: "INVALID_KEY"
    };
  }

  if (status === 403) {
    return {
      error: "Gemini API key is unauthorized or permissions are restricted. Please check your key in Settings.",
      code: "UNAUTHORIZED"
    };
  }

  if (status === 429) {
    return {
      error: "Gemini API rate limit exceeded. Please wait a few seconds and try again.",
      code: "RATE_LIMIT"
    };
  }

  if (status === 404) {
    return {
      error: `Model endpoint not found (${status}).`,
      code: "MODEL_NOT_FOUND"
    };
  }

  if (status >= 500) {
    return {
      error: `Gemini service is temporarily unavailable (${status}). Please try again shortly.`,
      code: "SERVER_ERROR"
    };
  }

  if (status === 400 || status === 403 || status === 404) {
    if (/private|unavailable|age.?restrict|copyright|cannot download|failed to fetch video/i.test(apiMessage)) {
      return {
        error: "This YouTube video is private, age-restricted, or unavailable for AI processing. Sahayak only supports accessible public YouTube videos.",
        code: "VIDEO_UNAVAILABLE"
      };
    }
  }

  const safeMessage = apiMessage ? apiMessage.replace(/AIza[0-9A-Za-z-_]{35}/g, "[REDACTED]") : `HTTP ${status}`;
  return {
    error: `Gemini API error: ${safeMessage}`,
    code: `HTTP_${status}`
  };
}

/**
 * Common REST execution logic for Gemini generateContent.
 * @param {object} payload
 * @param {string} apiKey
 * @param {string} model
 * @returns {Promise<{ ok: true, text: string, model: string } | { ok: false, error: string, code?: string }>}
 */
async function executeGenerateContent(payload, apiKey, model = DEFAULT_MODEL) {
  const key = apiKey ? String(apiKey).trim() : "";
  if (!key) {
    return {
      ok: false,
      error: "Set API key in Settings before Sahayak can call Gemini.",
      code: "NO_KEY"
    };
  }

  async function makeCall(modelName) {
    const url = `${API_BASE_URL}/${modelName}:generateContent?key=${encodeURIComponent(key)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const errInfo = parseApiError(response, data);
      return { ok: false, ...errInfo, status: response.status };
    }

    // Check candidate and safety
    const candidate = data?.candidates?.[0];
    if (!candidate) {
      const blockReason = data?.promptFeedback?.blockReason;
      if (blockReason) {
        return {
          ok: false,
          error: `The prompt or content was blocked by safety filters: ${blockReason}`,
          code: "SAFETY_BLOCK"
        };
      }
      return {
        ok: false,
        error: "Gemini returned no response candidate.",
        code: "EMPTY_CANDIDATE"
      };
    }

    if (candidate.finishReason && candidate.finishReason === "SAFETY") {
      return {
        ok: false,
        error: "The response was blocked by Gemini safety filters.",
        code: "SAFETY_BLOCK"
      };
    }

    const textPart = candidate.content?.parts?.find(
      (part) => typeof part.text === "string" && !part.thought
    );
    const text = textPart?.text ? textPart.text.trim() : "";

    if (!text) {
      return {
        ok: false,
        error: "The model returned an empty text response.",
        code: "EMPTY_RESPONSE"
      };
    }

    return {
      ok: true,
      text,
      model: modelName
    };
  }

  try {
    const firstAttempt = await makeCall(model);
    if (!firstAttempt.ok && firstAttempt.code === "MODEL_NOT_FOUND" && model !== FALLBACK_MODEL) {
      // Fallback model if primary model is unavailable
      const fallbackAttempt = await makeCall(FALLBACK_MODEL);
      return fallbackAttempt;
    }
    return firstAttempt;
  } catch (error) {
    return {
      ok: false,
      error: error?.message?.includes("Failed to fetch")
        ? "Network error: Unable to reach Gemini API. Please check your internet connection."
        : `Network error: ${error?.message || "Unknown error"}`,
      code: "NETWORK_ERROR"
    };
  }
}

/**
 * Execute a text generateContent REST call.
 * @param {object} params
 * @param {string} params.prompt
 * @param {string} params.apiKey
 * @param {string} [params.model]
 * @param {number} [params.temperature]
 * @param {number} [params.maxTokens]
 * @returns {Promise<{ ok: true, text: string, model: string } | { ok: false, error: string, code?: string }>}
 */
export async function generateText({
  prompt,
  apiKey,
  model = DEFAULT_MODEL,
  temperature = 0.3,
  maxTokens = 1024
}) {
  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens
    }
  };

  return executeGenerateContent(payload, apiKey, model);
}

/**
 * Builds the shared REST payload for a grounded chat completion.
 * @param {object} params
 * @param {string} [params.systemInstruction]
 * @param {Array<{ role: string, parts: Array<{ text: string }> }>} params.contents
 * @param {number} params.temperature
 * @param {number} params.maxTokens
 * @returns {object}
 */
function buildChatPayload({ systemInstruction, contents, temperature, maxTokens }) {
  /** @type {object} */
  const payload = {
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens
    }
  };

  if (systemInstruction) {
    payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  return payload;
}

/**
 * Executes a multi-turn grounded chat completion (non-streaming).
 * @param {object} params
 * @param {string} [params.systemInstruction]
 * @param {Array<{ role: string, parts: Array<{ text: string }> }>} params.contents
 * @param {string} params.apiKey
 * @param {string} [params.model]
 * @param {number} [params.temperature]
 * @param {number} [params.maxTokens]
 * @returns {Promise<{ ok: true, text: string, model: string } | { ok: false, error: string, code?: string }>}
 */
export async function generateChat({
  systemInstruction,
  contents,
  apiKey,
  model = DEFAULT_MODEL,
  temperature = 0.4,
  maxTokens = 1200
}) {
  const payload = buildChatPayload({ systemInstruction, contents, temperature, maxTokens });
  return executeGenerateContent(payload, apiKey, model);
}

/**
 * Executes a streaming grounded chat completion via the SSE `streamGenerateContent` endpoint.
 * Forwards incremental text through `onDelta`. Supports abort via `signal`.
 * @param {object} params
 * @param {string} [params.systemInstruction]
 * @param {Array<{ role: string, parts: Array<{ text: string }> }>} params.contents
 * @param {string} params.apiKey
 * @param {string} [params.model]
 * @param {number} [params.temperature]
 * @param {number} [params.maxTokens]
 * @param {(delta: string) => void} [params.onDelta]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ ok: true, text: string, model: string } | { ok: false, error: string, code?: string }>}
 */
export async function streamChat({
  systemInstruction,
  contents,
  apiKey,
  model = DEFAULT_MODEL,
  temperature = 0.4,
  maxTokens = 1200,
  onDelta,
  signal
}) {
  const key = apiKey ? String(apiKey).trim() : "";
  if (!key) {
    return {
      ok: false,
      error: "Set API key in Settings before Sahayak can call Gemini.",
      code: "NO_KEY"
    };
  }

  const payload = buildChatPayload({ systemInstruction, contents, temperature, maxTokens });
  const url = `${API_BASE_URL}/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, error: "Generation cancelled.", code: "ABORTED" };
    }
    return {
      ok: false,
      error: error?.message?.includes("Failed to fetch")
        ? "Network error: Unable to reach Gemini API. Please check your internet connection."
        : `Network error: ${error?.message || "Unknown error"}`,
      code: "NETWORK_ERROR"
    };
  }

  if (!response.ok) {
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { ok: false, ...parseApiError(response, data), status: response.status };
  }

  if (!response.body) {
    return { ok: false, error: "Streaming is not supported in this environment.", code: "STREAM_UNSUPPORTED" };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line.startsWith("data:")) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;

        let parsed;
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        const parts = parsed?.candidates?.[0]?.content?.parts || [];
        const delta = parts
          .filter((part) => typeof part.text === "string" && !part.thought)
          .map((part) => part.text)
          .join("");

        if (delta) {
          fullText += delta;
          if (typeof onDelta === "function") onDelta(delta);
        }
      }
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, error: "Generation cancelled.", code: "ABORTED" };
    }
    return { ok: false, error: `Streaming error: ${error?.message || "Unknown error"}`, code: "STREAM_ERROR" };
  }

  const text = fullText.trim();
  if (!text) {
    return { ok: false, error: "The model returned an empty response.", code: "EMPTY_RESPONSE" };
  }

  return { ok: true, text, model };
}

/**
 * Parses a base64 image data URL into its mime type and raw base64 payload.
 * @param {string} imageDataUrl
 * @returns {{ mimeType: string, data: string } | null}
 */
function parseImageDataUrl(imageDataUrl) {
  if (typeof imageDataUrl !== "string") return null;
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(imageDataUrl);
  if (!match) return null;
  const mimeType = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
  const data = match[2].replace(/\s/g, "");
  if (!data) return null;
  return { mimeType, data };
}

/**
 * Executes a multimodal generateContent REST call with an inline image (Slice 2.3).
 * Vision always uses a Flash-class model; images are never sent to text-only providers.
 * @param {object} params
 * @param {string} params.imageDataUrl Base64 data URL of the (cropped) screenshot.
 * @param {string} params.prompt
 * @param {string} params.apiKey
 * @param {string} [params.model]
 * @param {number} [params.temperature]
 * @param {number} [params.maxTokens]
 * @returns {Promise<{ ok: true, text: string, model: string } | { ok: false, error: string, code?: string }>}
 */
export async function generateVisionContent({
  imageDataUrl,
  prompt,
  apiKey,
  model = FALLBACK_MODEL,
  temperature = 0.3,
  maxTokens = 1200
}) {
  const image = parseImageDataUrl(imageDataUrl);
  if (!image) {
    return {
      ok: false,
      error: "The screenshot could not be read. Please capture again.",
      code: "INVALID_IMAGE"
    };
  }

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: image.mimeType, data: image.data } },
          { text: prompt }
        ]
      }
    ],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens
    }
  };

  return executeGenerateContent(payload, apiKey, model);
}

/**
 * Execute a video/YouTube generateContent REST call using Gemini fileUri.
 * Uses direct video URL input without scraping captions.
 * @param {object} params
 * @param {string} params.videoUrl Canonical YouTube URL (e.g. https://www.youtube.com/watch?v=...)
 * @param {string} params.prompt
 * @param {string} params.apiKey
 * @param {string} [params.model]
 * @param {number} [params.temperature]
 * @param {number} [params.maxTokens]
 * @returns {Promise<{ ok: true, text: string, model: string } | { ok: false, error: string, code?: string }>}
 */
export async function generateVideoContent({
  videoUrl,
  prompt,
  apiKey,
  model = DEFAULT_MODEL,
  temperature = 0.2,
  maxTokens = 2048
}) {
  if (!videoUrl || typeof videoUrl !== "string") {
    return {
      ok: false,
      error: "A valid YouTube video URL is required.",
      code: "INVALID_URL"
    };
  }

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          {
            fileData: {
              fileUri: videoUrl,
              mimeType: "video/*"
            }
          },
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens
    }
  };

  return executeGenerateContent(payload, apiKey, model);
}
