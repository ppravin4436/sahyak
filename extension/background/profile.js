/**
 * Local profile memory (Slice 4.1).
 *
 * Profile is stored at chrome.storage.local["profile"] — separate from the
 * "settings" key so keys, language prefs, and personal data are clearly
 * partitioned (architecture §12).
 *
 * Profile never syncs. Profile is never committed to git.
 * Profile is never sent to any model on a blocked page.
 *
 * Shape (all fields optional, all strings):
 * {
 *   name?:          string   – Display name / first name
 *   college?:       string   – College or university
 *   skills?:        string   – Comma-separated skill keywords
 *   links?:         string   – Portfolio / LinkedIn URL(s)
 *   preferredTone?: string   – Draft tone, e.g. "friendly and polite"
 * }
 */

export const PROFILE_KEY = "profile";

/**
 * Reads the stored profile.
 * Returns an empty object (never null) when nothing is saved.
 * @returns {Promise<object>}
 */
export async function getProfile() {
  try {
    const stored = await chrome.storage.local.get(PROFILE_KEY);
    const p = stored?.[PROFILE_KEY];
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

/**
 * Merges `updates` into the current profile and persists.
 * Only string values are accepted; unknown keys are silently dropped.
 * @param {object} updates
 * @returns {Promise<object>} The new merged profile.
 */
export async function saveProfile(updates) {
  const ALLOWED_KEYS = new Set(["name", "college", "skills", "links", "preferredTone"]);

  const current = await getProfile();
  const merged = { ...current };

  for (const [k, v] of Object.entries(updates || {})) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed) {
        merged[k] = trimmed;
      } else {
        delete merged[k]; // empty string = clear the field
      }
    }
  }

  await chrome.storage.local.set({ [PROFILE_KEY]: merged });
  return merged;
}

/**
 * Clears all profile fields.
 * @returns {Promise<void>}
 */
export async function clearProfile() {
  await chrome.storage.local.remove(PROFILE_KEY);
}

/**
 * Builds a compact, model-readable profile snippet for prompt injection.
 * Returns an empty string when the profile has no useful content.
 *
 * Format (plain text, intentionally terse so it doesn't dominate the prompt):
 *   User profile: Name: Pravi · College: IIT Bombay · Skills: React, Python
 *                 Links: https://github.com/pravi · Tone: concise
 *
 * @param {object} profile
 * @returns {string}
 */
export function buildProfileSnippet(profile) {
  if (!profile || typeof profile !== "object") return "";

  const parts = [];
  if (profile.name)          parts.push(`Name: ${profile.name}`);
  if (profile.college)       parts.push(`College: ${profile.college}`);
  if (profile.skills)        parts.push(`Skills: ${profile.skills}`);
  if (profile.links)         parts.push(`Links: ${profile.links}`);
  if (profile.preferredTone) parts.push(`Preferred tone: ${profile.preferredTone}`);

  if (!parts.length) return "";
  return `User profile: ${parts.join(" · ")}`;
}

/**
 * Returns the value from the profile that best matches a given node's
 * accessible name / placeholder.  Used by the agent loop to suggest
 * profile-sourced values for type actions (architecture §9.1).
 *
 * Rules:
 *  - Only non-sensitive nodes may receive profile values.
 *  - The match is keyword-based, not regex, to stay simple and auditable.
 *  - Returns null when no confident match is found.
 *
 * @param {object} node  ActionNode from the scanner.
 * @param {object} profile
 * @returns {{ field: string, value: string } | null}
 */
export function matchProfileValue(node, profile) {
  if (!node || !profile || typeof profile !== "object") return null;
  if (node.sensitive) return null;

  // Concatenate the node's text signals into a lowercase haystack.
  const haystack = [
    node.text || "",
    node.placeholder || "",
    node.name || "",
    node.id || ""
  ]
    .join(" ")
    .toLowerCase();

  // Ordered from most-specific to least-specific.
  const MATCHERS = [
    {
      field: "name",
      keywords: ["full name", "your name", "first name", "candidate name", "applicant name",
                 "name", "fname", "given name"]
    },
    {
      field: "college",
      keywords: ["college", "university", "institution", "school", "alma mater"]
    },
    {
      field: "skills",
      keywords: ["skills", "technologies", "tech stack", "expertise", "proficiencies"]
    },
    {
      field: "links",
      keywords: ["linkedin", "portfolio", "github", "website", "personal url", "profile url", "link"]
    },
  ];

  for (const { field, keywords } of MATCHERS) {
    const val = profile[field];
    if (!val) continue;
    for (const kw of keywords) {
      if (haystack.includes(kw)) {
        return { field, value: val };
      }
    }
  }

  return null;
}
