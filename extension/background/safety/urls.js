/**
 * URL safety validation for Sahayak (Slice 4.3).
 *
 * Responsibilities:
 *  - canSendToModel(url)   — gates every outbound AI call; returns {ok, reason}.
 *  - isPracticeOrigin(url) — bundled test-page allowlist (Slice 3.5).
 *  - isOwnedOrigin(url)    — user-declared "I own this" allowlist (Slice 4.3).
 *  - getOwnedOrigins()     — read ownedOrigins from chrome.storage.local.
 *  - addOwnedOrigin(url)   — add an origin to the allowlist.
 *  - removeOwnedOrigin(url)— remove an origin from the allowlist.
 *
 * Architecture §10.1 mandates: no capture, no extract upload, no execute on
 * blocked pages. Prompts may repeat the rules; this code is the control.
 */

/* ─────────────────────────────────────────────────────────────────────────
   Practice-origin allowlist (Slice 3.5)
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Path suffixes that identify a bundled practice page.
 * Matched against the full URL so both the chrome-extension:// origin AND
 * any http://localhost mirror work during development.
 */
export const PRACTICE_PAGE_PATHS = [
  "/test-pages/form.html",
  "/test-pages/shop.html"
];

/**
 * Returns true when `url` points to one of the bundled practice pages.
 * @param {string} url
 * @returns {boolean}
 */
export function isPracticeOrigin(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "chrome-extension:") {
      return PRACTICE_PAGE_PATHS.some((p) => parsed.pathname === p);
    }
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return PRACTICE_PAGE_PATHS.some((p) => parsed.pathname === p);
    }
    return false;
  } catch {
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Owned-origins allowlist (Slice 4.3)
   User explicitly marks "I control this page" to unlock the agent on any
   http/https origin that is not blocked by canSendToModel.
   ───────────────────────────────────────────────────────────────────────── */

const OWNED_ORIGINS_KEY = "ownedOrigins";

/**
 * Reads the user's owned-origins list.
 * Returns an array of origin strings (e.g. ["https://mysite.com"]).
 * @returns {Promise<string[]>}
 */
export async function getOwnedOrigins() {
  try {
    const stored = await chrome.storage.local.get(OWNED_ORIGINS_KEY);
    const list = stored?.[OWNED_ORIGINS_KEY];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Adds an origin to the owned-origins allowlist.
 * Only the origin part of the URL is stored (scheme + host + port).
 * @param {string} url  Any URL on the page the user wants to allow.
 * @returns {Promise<{ ok: true, origins: string[] } | { ok: false, error: string }>}
 */
export async function addOwnedOrigin(url) {
  let origin;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "Only http/https pages can be marked as owned." };
    }
    origin = parsed.origin; // e.g. "https://example.com"
  } catch {
    return { ok: false, error: "Invalid URL." };
  }

  const current = await getOwnedOrigins();
  if (current.includes(origin)) {
    return { ok: true, origins: current }; // already present
  }
  const next = [...current, origin].slice(0, 50); // cap at 50 origins
  await chrome.storage.local.set({ [OWNED_ORIGINS_KEY]: next });
  return { ok: true, origins: next };
}

/**
 * Removes an origin from the owned-origins allowlist.
 * @param {string} url  Any URL on the page (only the origin is matched).
 * @returns {Promise<string[]>} Updated list.
 */
export async function removeOwnedOrigin(url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return getOwnedOrigins();
  }
  const current = await getOwnedOrigins();
  const next = current.filter((o) => o !== origin);
  await chrome.storage.local.set({ [OWNED_ORIGINS_KEY]: next });
  return next;
}

/**
 * Returns true when `url` is on the user's owned-origins list.
 * Synchronous version for callers that have already fetched the list.
 * @param {string} url
 * @param {string[]} ownedOrigins  Pre-fetched list from getOwnedOrigins().
 * @returns {boolean}
 */
export function isOwnedOrigin(url, ownedOrigins) {
  if (!url || !Array.isArray(ownedOrigins) || !ownedOrigins.length) return false;
  try {
    const origin = new URL(url).origin;
    return ownedOrigins.includes(origin);
  } catch {
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Blocked schemes
   ───────────────────────────────────────────────────────────────────────── */

const BLOCKED_SCHEMES = new Set([
  "chrome:",
  "chrome-extension:",
  "edge:",
  "about:",
  "devtools:",
  "view-source:",
  "file:"
]);

/* ─────────────────────────────────────────────────────────────────────────
   Sensitive host lists (arch §10.1)
   Maintainable named lists; never match query-string secrets.
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Exact hostnames that are always blocked regardless of path.
 * Includes major Indian and international banking / payment / UPI portals.
 */
const BLOCKED_HOSTS = new Set([
  // Indian banks
  "netbanking.hdfcbank.com",
  "onlinebanking.icicibank.com",
  "retail.onlinesbi.sbi",
  "www.onlinesbi.sbi",
  "netbanking.axisbank.com",
  "ibanking.kotak.com",
  "netbanking.kotak.com",
  "pnbibanking.com",
  "netpnb.com",
  "unionbankonline.co.in",
  "bobibanking.com",
  "canarabank.com",
  "iobnet.co.in",
  "netbanking.indusind.com",
  "yesbank.in",
  "netbanking.yesbank.in",
  "rblbank.com",
  "my.rblbank.com",
  // UPI / payment apps
  "phonepe.com",
  "www.phonepe.com",
  "pay.google.com",
  "paytm.com",
  "payments.amazon.in",
  "bhimupi.org.in",
  "upi.npci.org.in",
  // International payment processors
  "checkout.stripe.com",
  "pay.stripe.com",
  "www.paypal.com",
  "paypal.com",
  "checkout.paypal.com",
  "secure.paypal.com",
  "razorpay.com",
  "checkout.razorpay.com",
  "ccavenue.com",
  "payu.in",
  "secure.payu.in",
  "instamojo.com",
  "billdesk.com"
]);

/**
 * Hostname suffix patterns (matched from the right so subdomains are covered).
 * e.g. "netbanking.hdfcbank.com" and "secure.hdfcbank.com" both match ".hdfcbank.com".
 */
const BLOCKED_HOST_SUFFIXES = [
  ".hdfcbank.com",
  ".icicibank.com",
  ".sbi.co.in",
  ".axisbank.com",
  ".kotak.com",
  ".pnb.co.in",
  ".canarabank.in",
  ".unionbankofindia.co.in",
  ".bobfinancial.com",
  ".stripe.com",
  ".paypal.com",
  ".razorpay.com",
  ".paytm.com",
  ".phonepe.com"
];

/**
 * Path / search patterns that indicate a sensitive transaction page
 * even on otherwise-allowable hosts.
 */
const BLOCKED_PATH_PATTERNS = [
  /\/upi\b/i,
  /\/payment[s]?\b/i,
  /\/checkout\b/i,
  /\/pay\b/i,
  /\/netbanking\b/i,
  /\/bank\/login/i,
  /\/transaction[s]?\b/i,
  /\/transfer\b/i,
  /\/fund-?transfer\b/i,
  /\/wallet\b/i,
  /\/billing\b/i,
  /\/card-?details\b/i,
  /\/add-?card\b/i,
  /\/secure-?pay\b/i,
  /\/order-?confirm/i,
  /\/place-?order/i
];

/* ─────────────────────────────────────────────────────────────────────────
   Main gate
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Checks whether the given URL can be safely sent to external AI models
 * (and whether a screenshot or page-extract can be uploaded).
 *
 * Returns { ok: true } only when ALL of the following pass:
 *  1. Scheme is http: or https:
 *  2. Host is not on the blocked-hosts list
 *  3. No blocked-host suffix matches
 *  4. Path/search does not match a payment/banking pattern
 *
 * @param {string} url
 * @returns {{ ok: boolean, reason?: string, code?: string }}
 */
export function canSendToModel(url) {
  if (!url || typeof url !== "string") {
    return { ok: false, reason: "No webpage URL provided.", code: "NO_URL" };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "Invalid webpage URL.", code: "INVALID_URL" };
  }

  // 1. Blocked schemes
  if (BLOCKED_SCHEMES.has(parsed.protocol)) {
    return {
      ok: false,
      reason: `Internal browser pages (${parsed.protocol}) cannot be sent to models.`,
      code: "BLOCKED_SCHEME"
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `Unsupported protocol (${parsed.protocol}). Only http/https pages are supported.`,
      code: "UNSUPPORTED_SCHEME"
    };
  }

  const host = parsed.hostname.toLowerCase();

  // 2. Exact host block
  if (BLOCKED_HOSTS.has(host)) {
    return {
      ok: false,
      reason: "Banking, payment, and UPI pages cannot be sent to remote models for your privacy and security.",
      code: "BLOCKED_HOST"
    };
  }

  // 3. Host suffix block
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) {
      return {
        ok: false,
        reason: "Banking, payment, and UPI pages cannot be sent to remote models for your privacy and security.",
        code: "BLOCKED_HOST"
      };
    }
  }

  // 4. Path / query pattern block
  const fullPath = `${parsed.pathname}${parsed.search}`;
  for (const pattern of BLOCKED_PATH_PATTERNS) {
    if (pattern.test(fullPath)) {
      return {
        ok: false,
        reason: "Payment, checkout, or banking pages cannot be sent to remote models for your privacy and security.",
        code: "BLOCKED_PATH"
      };
    }
  }

  return { ok: true };
}
