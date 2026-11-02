/**
 * Groq REST client for text-only fallback.
 * Uses OpenAI-compatible chat completions endpoint.
 */

export const GROQ_MODEL = "llama-3.3-70b-versatile";
const API_BASE_URL = "https://api.groq.com/openai/v1/chat/completions";

/**
 * Executes a text completion via Groq.
 * @param {object} params
 * @param {string} params.prompt
 * @param {string} params.apiKey
 * @param {string} [params.model]
 * @param {number} [params.temperature]
 * @param {number} [params.maxTokens]
 * @returns {Promise<{ ok: true, text: string, model: string } | { ok: false, error: string, code?: string }>}
 */
export async function generateGroqText({
  prompt,
  apiKey,
  model = GROQ_MODEL,
  temperature = 0.3,
  maxTokens = 1024
}) {
  const key = apiKey ? String(apiKey).trim() : "";
  if (!key) {
    return {
      ok: false,
      error: "Groq API key missing for fallback.",
      code: "NO_GROQ_KEY"
    };
  }

  try {
    const response = await fetch(API_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature,
        max_tokens: maxTokens
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return parseGroqError(response.status, data);
    }

    const text = data?.choices?.[0]?.message?.content?.trim() || "";
    if (!text) {
      return { ok: false, error: "Groq returned an empty response.", code: "EMPTY_RESPONSE" };
    }

    return { ok: true, text, model };
  } catch (error) {
    return {
      ok: false,
      error: error?.message?.includes("Failed to fetch")
        ? "Network error: Unable to reach Groq API."
        : `Groq error: ${error?.message || "Unknown error"}`,
      code: "NETWORK_ERROR"
    };
  }
}

function parseGroqError(status, data) {
  const message = data?.error?.message || `HTTP ${status}`;
  
  if (status === 401) {
    return { error: "Invalid Groq API key.", code: "INVALID_KEY" };
  }
  if (status === 429) {
    return { error: "Groq rate limit exceeded.", code: "RATE_LIMIT" };
  }
  if (status >= 500) {
    return { error: "Groq service is temporarily unavailable.", code: "SERVER_ERROR" };
  }

  return { error: `Groq API error: ${message}`, code: `HTTP_${status}` };
}
