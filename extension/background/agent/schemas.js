/**
 * Structured-output shapes and validators for agent tasks (Phase 3).
 * Model output is untrusted: it is parsed and validated here, and only the
 * validated fields are ever used. Anything else the model returns is dropped.
 */

const CONFIDENCE_LEVELS = ["high", "medium", "low"];

/**
 * Strips a single markdown code fence around a JSON body (edge case 3.2-05).
 * @param {string} text
 * @returns {string}
 */
export function stripCodeFence(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Builds the compact action map the model is allowed to see (architecture §8.2).
 * Never includes markup, styles, or DOM structure (edge case 3.1-15).
 * @param {{ url?: string, title?: string, scanGeneration?: number, truncated?: boolean, nodes?: Array<object> }} scan
 * @returns {{ url: string, title: string, scanGeneration: number, truncated: boolean, nodes: Array<object> }}
 */
export function buildActionMap(scan) {
  const nodes = Array.isArray(scan?.nodes) ? scan.nodes : [];

  return {
    url: scan?.url || "",
    title: scan?.title || "",
    scanGeneration: scan?.scanGeneration ?? 0,
    truncated: Boolean(scan?.truncated),
    nodes: nodes.map((node) => {
      const compact = { n: node.n, tag: node.tag };
      if (node.role) compact.role = node.role;
      if (node.type) compact.type = node.type;
      if (node.text) compact.text = node.text;
      if (node.placeholder) compact.placeholder = node.placeholder;
      if (node.href) compact.href = node.href;
      if (node.disabled) compact.disabled = true;
      if (node.sensitive) compact.sensitive = true;
      if (node.consequential) compact.consequential = true;
      return compact;
    })
  };
}

/**
 * Validates a find-it model reply against the `{ n, confidence, reason }` shape.
 *
 * `n` is the only field that can cause a highlight. `click`, `action`, `url`,
 * and any other key the model invents are ignored (edge case 3.2-01).
 *
 * @param {string} rawText Raw model output, possibly fenced.
 * @param {object} options
 * @param {number} options.nodeCount Number of nodes in the scanned action map.
 * @returns {{ ok: true, data: { n: number|null, confidence: string, reason: string, clarification: boolean } }
 *   | { ok: false, code: string, error: string }}
 */
export function validateFindIt(rawText, { nodeCount }) {
  const body = stripCodeFence(rawText);

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      ok: false,
      code: "BAD_JSON",
      error: "The reply was not valid JSON."
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      code: "BAD_JSON",
      error: "The reply was not a JSON object."
    };
  }

  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  if (!reason) {
    return {
      ok: false,
      code: "INVALID_SHAPE",
      error: "The reply was missing a reason."
    };
  }

  const confidence = CONFIDENCE_LEVELS.includes(parsed.confidence) ? parsed.confidence : "low";

  // `n: null` is how the model asks for clarification instead of guessing (3.2-04, 3.2-07).
  if (parsed.n === null || parsed.n === undefined) {
    return {
      ok: true,
      data: { n: null, confidence, reason, clarification: true }
    };
  }

  const n = Number(parsed.n);
  if (!Number.isInteger(n) || n < 1 || n > nodeCount) {
    return {
      ok: false,
      code: "OUT_OF_RANGE",
      error: `Element number ${parsed.n} is not one of the numbered elements on this page.`
    };
  }

  return {
    ok: true,
    data: { n, confidence, reason, clarification: false }
  };
}

const ACTION_TYPES = ["click", "type", "select", "scroll", "done"];
const SCROLL_DIRECTIONS = ["up", "down", "intoView"];

/**
 * Validates a one-step agent action against the `AgentAction` schema (§8.4).
 *
 * The model may only ever produce one action: an array or a non-action object is
 * rejected (edge case 3.3-02). Extra keys are ignored; only the fields below are
 * ever used to drive the executor.
 *
 * @param {string} rawText Raw model output, possibly fenced.
 * @param {object} options
 * @param {number} options.nodeCount Number of nodes in the scanned action map.
 * @returns {{ ok: true, data: object } | { ok: false, code: string, error: string }}
 */
export function validateAgentAction(rawText, { nodeCount }) {
  const body = stripCodeFence(rawText);

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, code: "BAD_JSON", error: "The reply was not valid JSON." };
  }

  // Edge case 3.3-02: exactly one action object, never an array of actions.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      code: "BAD_JSON",
      error: "The reply must be a single action object, not a list."
    };
  }

  const type = typeof parsed.type === "string" ? parsed.type.toLowerCase() : "";
  if (!ACTION_TYPES.includes(type)) {
    return {
      ok: false,
      code: "BAD_TYPE",
      error: `"${parsed.type}" is not an action Sahayak can run.`
    };
  }

  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  if (!reason) {
    return { ok: false, code: "INVALID_SHAPE", error: "The action was missing a reason." };
  }

  if (type === "done") {
    return { ok: true, data: { type, reason } };
  }

  if (type === "scroll") {
    const direction = SCROLL_DIRECTIONS.includes(parsed.direction) ? parsed.direction : null;
    if (!direction) {
      return {
        ok: false,
        code: "INVALID_SHAPE",
        error: "A scroll action needs a direction of up, down, or intoView."
      };
    }
    const action = { type, direction, reason };
    if (parsed.n !== undefined && parsed.n !== null) {
      const n = Number(parsed.n);
      if (!Number.isInteger(n) || n < 1 || n > nodeCount) {
        return {
          ok: false,
          code: "OUT_OF_RANGE",
          error: `Element number ${parsed.n} is not one of the numbered elements on this page.`
        };
      }
      action.n = n;
    }
    return { ok: true, data: action };
  }

  const n = Number(parsed.n);
  if (!Number.isInteger(n) || n < 1 || n > nodeCount) {
    return {
      ok: false,
      code: "OUT_OF_RANGE",
      error: `Element number ${parsed.n} is not one of the numbered elements on this page.`
    };
  }

  if (type === "click") {
    return { ok: true, data: { type, n, reason } };
  }

  const value = typeof parsed.value === "string" ? parsed.value : null;
  if (value === null) {
    return {
      ok: false,
      code: "INVALID_SHAPE",
      error: `A ${type} action needs a text "value".`
    };
  }

  return { ok: true, data: { type, n, value, reason } };
}
