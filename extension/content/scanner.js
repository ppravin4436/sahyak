/**
 * Sahayak Scanner (scanner.js)
 * Finds interactive elements, filters out what the user cannot really act on,
 * numbers them for the current scan generation, and draws numbered badges
 * through content/overlay.js.
 *
 * Only compact ActionNode JSON ever leaves this file — never innerHTML
 * (edge case 3.1-15).
 */

(() => {
  /** Hard cap on how many nodes we hand back / number on screen (3.1-05). */
  const MAX_NODES = 100;
  const MAX_TEXT_CHARS = 80;
  const OVERLAY_ATTR = "data-sahayak-overlay";

  const SELECTOR = [
    "a[href]",
    "button",
    "[role=button]",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "[role=checkbox]",
    "[role=combobox]",
    "summary",
    "[onclick]"
  ].join(",");

  /** A real control that should win over a generic wrapper around it. */
  const NATIVE_CONTROLS = ["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"];

  const CONSEQUENTIAL_RE =
    /\b(submit|send|pay|buy|purchase|order|checkout|confirm|delete|remove|transfer|withdraw|donate|subscribe|unsubscribe|post|publish|apply|book|reserve|sign in|log in|register|create account|save)\b/i;

  const SENSITIVE_RE = /\b(password|passcode|otp|one[- ]?time|pin|cvv|cvc|card number|security code)\b/i;

  function truncate(text, max = MAX_TEXT_CHARS) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    return clean.length > max ? `${clean.slice(0, max)}…` : clean;
  }

  /** Accessible name, preferring explicit labelling over raw text. */
  function accessibleName(el) {
    const ariaLabel = el.getAttribute?.("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const labelledBy = el.getAttribute?.("aria-labelledby");
    if (labelledBy) {
      const joined = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
        .trim();
      if (joined) return joined;
    }

    const nativeLabels = el.labels;
    if (nativeLabels && nativeLabels.length) {
      const joined = Array.from(nativeLabels)
        .map((label) => label.textContent || "")
        .join(" ")
        .trim();
      if (joined) return joined;
    }

    if (el.placeholder && el.placeholder.trim()) return el.placeholder.trim();

    const type = (el.getAttribute?.("type") || "").toLowerCase();
    if (type === "submit" || type === "button" || type === "reset") {
      if (el.value && el.value.trim()) return el.value.trim();
    }

    const title = el.getAttribute?.("title");
    if (title && title.trim()) return title.trim();

    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (text) return text;

    const alt = el.querySelector?.("img[alt]")?.getAttribute("alt");
    if (alt && alt.trim()) return alt.trim();

    return el.getAttribute?.("name") || "";
  }

  /** origin + path only — query strings can carry tokens (architecture §8.1). */
  function hrefOf(el) {
    if (el.tagName !== "A") return undefined;
    try {
      const url = new URL(el.href, location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
      return url.origin + url.pathname;
    } catch {
      return undefined;
    }
  }

  function isSensitive(el) {
    const type = (el.getAttribute?.("type") || "").toLowerCase();
    if (type === "password") return true;

    const autocomplete = (el.getAttribute?.("autocomplete") || "").toLowerCase();
    if (/password|one-time-code|cc-number|cc-csc|cc-exp/.test(autocomplete)) return true;

    const haystack = [
      el.getAttribute?.("name"),
      el.id,
      el.getAttribute?.("placeholder"),
      el.getAttribute?.("aria-label"),
      accessibleName(el)
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return SENSITIVE_RE.test(haystack);
  }

  function isConsequential(el) {
    const type = (el.getAttribute?.("type") || "").toLowerCase();
    if (el.tagName === "INPUT" && (type === "submit" || type === "image")) return true;
    if (el.tagName === "BUTTON" && el.type === "submit") return true;

    const haystack = `${accessibleName(el)} ${el.id || ""} ${el.getAttribute?.("name") || ""}`;
    return CONSEQUENTIAL_RE.test(haystack);
  }

  function isDisabled(el) {
    if (el.disabled === true) return true;
    if (el.getAttribute?.("aria-disabled") === "true") return true;
    return false;
  }

  function styleHidden(el) {
    const view = el.ownerDocument?.defaultView || window;
    let style;
    try {
      style = view.getComputedStyle(el);
    } catch {
      return false;
    }
    if (style.display === "none") return true;
    if (style.visibility === "hidden" || style.visibility === "collapse") return true;
    if (Number(style.opacity) === 0) return true;
    return false;
  }

  function isFocusableNative(el) {
    if (!NATIVE_CONTROLS.includes(el.tagName)) return false;
    return el.tabIndex >= 0 && !isDisabled(el);
  }

  function isInOverlay(el) {
    if (el.hasAttribute?.(OVERLAY_ATTR)) return true;
    return Boolean(el.closest?.(`[${OVERLAY_ATTR}]`));
  }

  /**
   * Resolves the box to draw the badge over. Visually custom file inputs are
   * commonly hidden behind their label (edge case 3.1-11).
   * @returns {{ visible: boolean, badgeEl: Element }}
   */
  function resolveBox(el) {
    const rect = el.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && !styleHidden(el);
    if (visible) return { visible: true, badgeEl: el };

    const type = (el.getAttribute?.("type") || "").toLowerCase();
    if (el.tagName === "INPUT" && type === "file") {
      const labelEl = el.labels && el.labels[0];
      if (labelEl && labelEl.getBoundingClientRect().width > 0 && !styleHidden(labelEl)) {
        return { visible: true, badgeEl: labelEl };
      }
    }

    return { visible: false, badgeEl: el };
  }

  /** Report a viewport-visible element before an element merely present in the DOM. */
  function isInViewport(el) {
    const rect = el.getBoundingClientRect();
    const height = window.innerHeight || document.documentElement.clientHeight;
    const width = window.innerWidth || document.documentElement.clientWidth;
    return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width;
  }

  /** Elements parked far outside the document (skip links, off-canvas menus). */
  function isParkedOffPage(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + (window.scrollX || 0);
    const y = rect.top + (window.scrollY || 0);
    return x + rect.width <= 0 || y + rect.height <= 0;
  }

  function collectCandidates() {
    const found = Array.from(document.querySelectorAll(SELECTOR));
    const out = [];
    const seen = new Set();

    for (const el of found) {
      if (seen.has(el)) continue;
      if (isInOverlay(el)) continue; // edge case 3.1-06
      if (el.closest?.(`[${OVERLAY_ATTR}]`)) continue;

      // Edge case 3.1-02: a label is never its own node when it owns a control.
      if (el.tagName === "LABEL") {
        const control =
          el.control ||
          (el.htmlFor ? document.getElementById(el.htmlFor) : null) ||
          el.querySelector("input:not([type=hidden]), textarea, select, button");
        if (control && control !== el) continue;
      }

      // Edge case 3.1-11: hidden inputs are never actionable, even if they carry onclick.
      if (el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "hidden") continue;

      // A generic wrapper (e.g. div[onclick]) that only exists to hold a real control.
      if (
        !NATIVE_CONTROLS.includes(el.tagName) &&
        el.querySelector("button, a[href], input:not([type=hidden]), textarea, select")
      ) {
        continue;
      }

      if (!resolveBox(el).visible) continue;
      if (isParkedOffPage(el)) continue;

      // Edge case 3.1-01: aria-hidden is excluded unless it is still the real control.
      if (el.closest('[aria-hidden="true"]') && !isFocusableNative(el)) continue;

      seen.add(el);
      out.push(el);
    }

    return out;
  }

  function toActionNode(el, n) {
    const rect = el.getBoundingClientRect();
    const type = (el.getAttribute?.("type") || "").toLowerCase();
    const role = el.getAttribute?.("role") || undefined;
    const name = el.getAttribute?.("name") || undefined;

    return {
      n,
      tag: el.tagName.toLowerCase(),
      role,
      type: el.tagName === "INPUT" ? type || "text" : undefined,
      name,
      id: el.id || undefined,
      text: truncate(accessibleName(el)),
      placeholder: el.getAttribute?.("placeholder") || undefined,
      href: hrefOf(el),
      disabled: isDisabled(el),
      sensitive: isSensitive(el),
      consequential: isConsequential(el),
      bbox: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      }
    };
  }

  /** The element behind each `n` of the most recent scan, keyed by number. */
  let scanRegistry = new Map();

  function performScan() {
    const generation = (window.__sahayakScanGeneration || 0) + 1;
    window.__sahayakScanGeneration = generation;

    const candidates = collectCandidates();
    const totalFound = candidates.length;

    // Edge case 3.1-05: cap the list, preferring what the user can see now.
    const ordered = [
      ...candidates.filter(isInViewport),
      ...candidates.filter((el) => !isInViewport(el))
    ];
    const kept = ordered.slice(0, MAX_NODES);

    const nodes = kept.map((el, index) => toActionNode(el, index + 1));
    scanRegistry = new Map(kept.map((el, index) => [index + 1, el]));

    const overlay = window.__SahayakOverlay;
    if (overlay) {
      overlay.render(
        kept.map((el, index) => ({
          n: index + 1,
          el: resolveBox(el).badgeEl,
          sensitive: nodes[index].sensitive,
          consequential: nodes[index].consequential
        }))
      );
    }

    return {
      url: location.href,
      title: document.title || "Untitled page",
      scanGeneration: generation,
      nodes,
      totalFound,
      truncated: totalFound > kept.length,
      dropped: Math.max(0, totalFound - kept.length),
      // Edge case 3.1-10: cross-origin frames are never claimed as controllable.
      containsFrames: document.querySelectorAll("iframe, frame").length > 0
    };
  }

  if (!window.__sahayakScannerLoaded) {
    window.__sahayakScannerLoaded = true;

    /**
     * Read-only handle used by content/executor.js to turn a step's `n` into a
     * live element and to check freshness before any DOM write (Slice 3.3).
     */
    window.__SahayakScanner = {
      resolve(n) {
        const el = scanRegistry.get(Number(n));
        return el && el.isConnected ? el : null;
      },
      generation() {
        return window.__sahayakScanGeneration || 0;
      },
      isSensitive,
      isConsequential,
      accessibleName
    };

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message !== "object") return false;

      if (message.type === "SCAN_PAGE") {
        try {
          sendResponse({ ok: true, data: performScan() });
        } catch (err) {
          sendResponse({ ok: false, error: err?.message || "Could not scan this page." });
        }
        return true;
      }

      if (message.type === "CLEAR_OVERLAY") {
        window.__SahayakOverlay?.clear();
        sendResponse({ ok: true, data: { cleared: true } });
        return true;
      }

      if (message.type === "HIGHLIGHT_ELEMENT") {
        const n = Number(message.payload?.n);
        const requestedGeneration = message.payload?.scanGeneration;

        // Edge case 3.2-08: a stale index is never highlighted.
        if (
          typeof requestedGeneration === "number" &&
          requestedGeneration !== (window.__sahayakScanGeneration || 0)
        ) {
          sendResponse({
            ok: false,
            code: "STALE_SCAN",
            error: "The page changed since the scan."
          });
          return true;
        }

        const el = scanRegistry.get(n);
        if (!el || !el.isConnected) {
          sendResponse({
            ok: false,
            code: "NODE_GONE",
            error: "That element is no longer on the page."
          });
          return true;
        }

        const highlighted = window.__SahayakOverlay?.highlight(n);
        sendResponse({ ok: true, data: { n, highlighted: Boolean(highlighted) } });
        return true;
      }

      return false;
    });
  }

  return { loaded: true };
})();
