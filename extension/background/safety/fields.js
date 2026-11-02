/**
 * Field-level sensitivity guards (Slice 4.3).
 *
 * Architecture §10.2 — refuse `type` when the target field is:
 *   - input[type=password]
 *   - autocomplete includes one-time-code, cc-number, cc-csc, cc-exp, cc-exp-month,
 *     cc-exp-year, cc-additional-name, cc-type, transaction-amount, transaction-currency
 *   - accessible name / placeholder / name attribute / aria-label matches OTP, PIN,
 *     CVV, card number, UPI PIN, security code
 *   - inputmode=numeric plus OTP-ish naming
 *
 * This module is imported by the service worker (loop.js pre-check) and
 * mirrored in the content script (executor.js last-resort check).
 * Both must refuse — the executor check is the final guard before DOM mutation.
 *
 * NOTE: This file is a plain ES module used from the SW context.
 *       The content-script version (executor.js) cannot import from here directly
 *       because content scripts injected via executeScript do not support SW-side
 *       module paths.  executor.js therefore carries its own parallel implementation
 *       that is kept in sync with these rules.
 */

/**
 * `autocomplete` attribute values that indicate a protected field.
 * Stored as an array so new values can be added in one place.
 */
export const SENSITIVE_AUTOCOMPLETE_VALUES = [
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-additional-name",
  "cc-type",
  "transaction-amount",
  "transaction-currency"
];

/**
 * Regex for name/id/placeholder/aria-label keyword matching.
 * Word-boundary anchored to avoid false positives on e.g. "pincode" or "discount".
 */
export const SENSITIVE_NAME_RE =
  /\b(password|passcode|passphrase|otp|one[- ]?time[- ]?(?:pass(?:word|code)?|code)?|pin\b|cvv|cvc\b|card[- ]?number|card[- ]?no|cardno|security[- ]?code|upi[- ]?pin|upi[- ]?id|mpin|tpin|transaction[- ]?pin)\b/i;

/**
 * Checks whether a DOM element is a protected sensitive field.
 * Designed to be called from the service worker (pre-approve gate in loop.js).
 *
 * This function operates on a compact ActionNode (the serialised scanner output),
 * NOT a live DOM element — the SW never has access to the live DOM.
 *
 * @param {object} node  ActionNode from scanner.js
 * @returns {boolean}
 */
export function isSensitiveNode(node) {
  if (!node || typeof node !== "object") return false;

  // Trust the scanner's own flag first (fastest path).
  if (node.sensitive === true) return true;

  const type = (node.type || "").toLowerCase();

  // input[type=password] is always sensitive.
  if (type === "password") return true;

  // autocomplete attribute check.
  const autocomplete = (node.autocomplete || "").toLowerCase().trim();
  if (autocomplete) {
    // autocomplete can be a space-separated list of tokens.
    const tokens = autocomplete.split(/\s+/);
    for (const token of tokens) {
      if (SENSITIVE_AUTOCOMPLETE_VALUES.includes(token)) return true;
    }
  }

  // Name / id / placeholder / text keyword check.
  const haystack = [
    node.text || "",
    node.placeholder || "",
    node.name || "",
    node.id || ""
  ]
    .join(" ")
    .toLowerCase();

  if (SENSITIVE_NAME_RE.test(haystack)) return true;

  // inputmode=numeric + OTP-ish name is a common pattern for OTP fields.
  const inputmode = (node.inputmode || "").toLowerCase();
  if (inputmode === "numeric" && /\b(otp|one[- ]?time|code|pin|cvv|mpin|tpin)\b/i.test(haystack)) {
    return true;
  }

  return false;
}
