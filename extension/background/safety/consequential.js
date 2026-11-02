/**
 * Consequential-action detection (Slice 4.3).
 *
 * Architecture §10.3 — if the accessible name matches these verbs, or the
 * element is input[type=submit], require an extra confirmation from the user
 * (a second tap of Approve) even after the first Approve.
 *
 * "Do not automate: logins, payments, OTP." — anything that triggers a
 * real-world consequence is gated here.
 *
 * This module is used by both:
 *  - loop.js (SW side) — to set pendingAction.consequential on proposals.
 *  - scanner.js (content-script side) — has its own parallel CONSEQUENTIAL_RE
 *    kept in sync with these rules.
 */

/**
 * Verb / phrase patterns that indicate a consequential action.
 * Tested against the accessible name, aria-label, button text, and value.
 */
export const CONSEQUENTIAL_RE =
  /\b(submit|send|pay|buy|purchase|order|checkout|confirm|confirm[- ]?order|place[- ]?order|place[- ]?bid|delete[- ]?account|remove[- ]?account|deactivate|unsubscribe|transfer|withdraw|donate|register|create[- ]?account|sign[- ]?up|sign[- ]?in|log[- ]?in|login|book|reserve|apply|schedule|activate|upgrade|downgrade|renew|publish|post|launch|deploy)\b/i;

/**
 * Additional exact phrases that are always consequential regardless of word boundaries.
 */
const CONSEQUENTIAL_PHRASES = [
  "pay now",
  "pay & confirm",
  "confirm & pay",
  "complete purchase",
  "complete order",
  "complete booking",
  "place order",
  "submit application",
  "submit form",
  "send money",
  "transfer funds",
  "delete account",
  "remove account",
  "cancel subscription",
  "i agree",
  "agree & continue",
  "proceed to payment",
  "proceed to checkout",
  "make payment",
  "confirm payment"
];

/**
 * Checks whether an ActionNode represents a consequential action that
 * requires a second user confirmation before execution.
 *
 * A node is consequential when ANY of the following is true:
 *   - It is input[type=submit] or input[type=image]
 *   - It is a <button> with type="submit"
 *   - Its accessible name matches CONSEQUENTIAL_RE
 *   - Its accessible name contains one of the CONSEQUENTIAL_PHRASES
 *
 * @param {object} node  ActionNode (serialised scanner output)
 * @returns {boolean}
 */
export function isConsequentialNode(node) {
  if (!node || typeof node !== "object") return false;

  // Trust the scanner's own flag first.
  if (node.consequential === true) return true;

  const tag = (node.tag || "").toLowerCase();
  const type = (node.type || "").toLowerCase();

  // input[type=submit] and input[type=image] are always consequential.
  if (tag === "input" && (type === "submit" || type === "image")) return true;

  // Collect all text signals into one lowercase string.
  const haystack = [
    node.text || "",
    node.name || "",
    node.id || "",
    node.placeholder || ""
  ]
    .join(" ")
    .toLowerCase();

  if (CONSEQUENTIAL_RE.test(haystack)) return true;

  for (const phrase of CONSEQUENTIAL_PHRASES) {
    if (haystack.includes(phrase)) return true;
  }

  return false;
}
