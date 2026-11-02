/**
 * Sahayak Executor (executor.js)
 * Runs exactly one approved action in the page. This is a fixed switch on the
 * action `type` — model-supplied JavaScript is never evaluated (edge case 3.3-21).
 *
 * Every guard here fails closed: a stale index, a missing node, a sensitive
 * field, or an unknown action all refuse to touch the DOM.
 *
 * Slice 4.3: isSensitiveField() is expanded to match ALL rules from
 * safety/fields.js (architecture §10.2). The SW-side isSensitiveNode() in
 * fields.js is the canonical definition; this function is kept in sync.
 */

(() => {
  if (window.__sahayakExecutorLoaded) return { loaded: true };
  window.__sahayakExecutorLoaded = true;

  const ALLOWED = new Set(["click", "type", "select", "scroll", "done"]);

  /**
   * autocomplete token values that mark a field as sensitive (§10.2).
   * Keep in sync with safety/fields.js SENSITIVE_AUTOCOMPLETE_VALUES.
   */
  const SENSITIVE_AUTOCOMPLETE = new Set([
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
  ]);

  /**
   * Name / placeholder / aria-label keyword pattern.
   * Keep in sync with safety/fields.js SENSITIVE_NAME_RE.
   */
  const SENSITIVE_RE =
    /\b(password|passcode|passphrase|otp|one[- ]?time[- ]?(?:pass(?:word|code)?|code)?|pin\b|cvv|cvc\b|card[- ]?number|card[- ]?no|cardno|security[- ]?code|upi[- ]?pin|upi[- ]?id|mpin|tpin|transaction[- ]?pin)\b/i;

  function scanner() {
    return window.__SahayakScanner || null;
  }

  function generation() {
    return scanner()?.generation?.() ?? 0;
  }

  function resolve(n) {
    const api = scanner();
    const el = api?.resolve?.(n);
    return el && el.isConnected ? el : null;
  }

  /**
   * Comprehensive sensitive-field check (architecture §10.2).
   * Runs immediately before any DOM write. Fails closed on every ambiguity.
   *
   * Checks (in order):
   *  1. scanner API flag (fastest)
   *  2. input[type=password]
   *  3. autocomplete token list (one-time-code, cc-number, cc-csc, cc-exp, …)
   *  4. name / placeholder / aria-label keyword match
   *  5. inputmode=numeric + OTP-ish naming
   *
   * @param {Element} el
   * @returns {boolean}
   */
  function isSensitiveField(el) {
    // 1. Delegate to scanner API when available.
    const api = scanner();
    if (typeof api?.isSensitive === "function") return api.isSensitive(el);

    // 2. type=password is always sensitive.
    const type = (el.getAttribute?.("type") || "").toLowerCase();
    if (type === "password") return true;

    // 3. autocomplete token check.
    const autocomplete = (el.getAttribute?.("autocomplete") || "").toLowerCase().trim();
    if (autocomplete) {
      for (const token of autocomplete.split(/\s+/)) {
        if (SENSITIVE_AUTOCOMPLETE.has(token)) return true;
      }
    }

    // 4. Name / id / placeholder / aria-label keyword match.
    const haystack = [
      el.getAttribute?.("name"),
      el.id,
      el.getAttribute?.("placeholder"),
      el.getAttribute?.("aria-label"),
      el.getAttribute?.("aria-labelledby")
        ? (document.getElementById(el.getAttribute("aria-labelledby"))?.textContent || "")
        : ""
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (SENSITIVE_RE.test(haystack)) return true;

    // 5. inputmode=numeric + OTP-ish naming.
    const inputmode = (el.getAttribute?.("inputmode") || "").toLowerCase();
    if (
      inputmode === "numeric" &&
      /\b(otp|one[- ]?time|code|pin|cvv|mpin|tpin)\b/i.test(haystack)
    ) {
      return true;
    }

    return false;
  }

  /** Sets a value the way a user would, so framework listeners notice (3.3-09). */
  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function doClick(el) {
    const type = (el.getAttribute?.("type") || "").toLowerCase();
    // Edge case 3.3-18: never drive the OS file picker.
    if (el.tagName === "INPUT" && type === "file") {
      return {
        ok: false,
        code: "FILE_PICKER",
        error: "Sahayak cannot choose a file for you — click the field and pick it yourself."
      };
    }
    if (el.disabled === true) {
      return { ok: false, code: "DISABLED", error: "That control is disabled." };
    }
    try {
      el.scrollIntoView({ block: "center", inline: "nearest" });
    } catch {
      // Not scrolling is fine; the click still happens.
    }
    el.click();
    return { ok: true, data: { executed: "click" } };
  }

  function doType(el, value) {
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
      return { ok: false, code: "NOT_A_FIELD", error: "That element is not a text field." };
    }
    // Slice 4.3: check type, autocomplete, and name-pattern — all three gates
    // must pass before any value is written (architecture §10.2).
    if (isSensitiveField(el)) {
      return {
        ok: false,
        code: "SENSITIVE_BLOCKED",
        error: "Sahayak never types into password, OTP, or card fields."
      };
    }
    if (el.disabled === true || el.readOnly === true) {
      return { ok: false, code: "DISABLED", error: "That field is not editable." };
    }
    el.focus();
    setNativeValue(el, String(value ?? ""));
    return { ok: true, data: { executed: "type" } };
  }

  function doSelect(el, value) {
    if (!(el instanceof HTMLSelectElement)) {
      return { ok: false, code: "NOT_A_SELECT", error: "That element is not a dropdown." };
    }
    const wanted = String(value ?? "").trim();
    const options = Array.from(el.options || []);
    const match =
      options.find((option) => option.value === wanted) ||
      options.find((option) => option.value.toLowerCase() === wanted.toLowerCase()) ||
      options.find((option) => (option.textContent || "").trim().toLowerCase() === wanted.toLowerCase());

    // Edge case 3.3-10: never pick a random option.
    if (!match) {
      return {
        ok: false,
        code: "OPTION_NOT_FOUND",
        error: `That dropdown has no option called "${wanted}".`
      };
    }
    el.value = match.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, data: { executed: "select", value: match.value } };
  }

  function doScroll(action) {
    // Edge case 3.3-11: with no `n`, scroll the page by direction only.
    if (typeof action.n === "number") {
      const el = resolve(action.n);
      if (!el) {
        return { ok: false, code: "NODE_GONE", error: "That element is no longer on the page." };
      }
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      return { ok: true, data: { executed: "scroll" } };
    }
    const direction = action.direction === "up" ? -1 : 1;
    window.scrollBy({ top: Math.round(window.innerHeight * 0.8) * direction, behavior: "smooth" });
    return { ok: true, data: { executed: "scroll" } };
  }

  /**
   * Executes one action object. Unknown or unsafe actions never reach the DOM.
   * @param {object} action
   * @param {number} [scanGeneration]
   * @param {boolean} [dryRun] When true, refuse all DOM writes (defence-in-depth).
   */
  function execute(action, scanGeneration, dryRun) {
    if (!action || typeof action !== "object" || !ALLOWED.has(action.type)) {
      return { ok: false, code: "BAD_ACTION", error: "That is not an action Sahayak can run." };
    }

    if (action.type === "done") return { ok: true, data: { executed: "done" } };

    // Defence-in-depth: dry-run is decided in loop.js before execute is ever called,
    // but refuse here too so no code path can accidentally write the DOM in dry-run.
    if (dryRun) {
      return { ok: true, data: { executed: "dry-run", skipped: action.type } };
    }

    // Edge cases 3.3-05, 3.3-16: a stale index is never executed.
    if (typeof scanGeneration === "number" && scanGeneration !== generation()) {
      return {
        ok: false,
        code: "STALE_SCAN",
        error: "The page changed since this step was proposed."
      };
    }

    if (action.type === "scroll") return doScroll(action);

    const el = resolve(action.n);
    if (!el) {
      return { ok: false, code: "NODE_GONE", error: "That element is no longer on the page." };
    }

    if (action.type === "click") return doClick(el);
    if (action.type === "type") return doType(el, action.value);
    if (action.type === "select") return doSelect(el, action.value);

    return { ok: false, code: "BAD_ACTION", error: "That action is not supported." };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    if (message.type !== "EXECUTE_ACTION") return false;

    try {
      sendResponse(execute(
        message.payload?.action,
        message.payload?.scanGeneration,
        Boolean(message.payload?.dryRun)
      ));
    } catch (err) {
      sendResponse({
        ok: false,
        code: "EXECUTE_FAILED",
        error: err?.message || "The action failed."
      });
    }
    return true;
  });

  return { loaded: true };
})();
