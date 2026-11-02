/**
 * Saved skills storage (Slice 4.2).
 *
 * Skills are stored at chrome.storage.local["skills"] — separate from
 * "settings" and "profile" as per architecture §12.
 *
 * A skill is a local prompt recipe:
 * {
 *   id:          string  – crypto.randomUUID()
 *   name:        string  – display name (≤ 60 chars)
 *   description: string  – one-line description (≤ 140 chars)
 *   kind:        "summarise" | "chat" | "draft"
 *   prompt:      string  – the extra instruction appended to the page context (≤ 2000 chars)
 *   language?:   "en" | "hinglish"
 *   createdAt:   string  – ISO timestamp
 * }
 *
 * "agent" kind from the spec is reserved for Phase 4+ full implementation;
 * the schema accepts it but the runner falls back to a plain chat turn.
 *
 * Security rules (identical discipline to profile.js):
 *  - Only ALLOWED_KEYS fields are persisted; unknown keys are dropped on save/import.
 *  - Prompt and name/description are capped to avoid token-bomb imports.
 *  - Remote URLs embedded in prompts are not executed — the prompt is just text injected
 *    before a model call that the service worker still gates through canSendToModel.
 *  - Never auto-run on import.
 *  - Never stored in git.
 */

export const SKILLS_KEY = "skills";

const ALLOWED_KINDS = new Set(["summarise", "chat", "draft", "agent"]);
const MAX_NAME_LEN = 60;
const MAX_DESC_LEN = 140;
const MAX_PROMPT_LEN = 2000;
const MAX_SKILLS = 50; // cap the list to prevent oversized storage writes

/**
 * Reads the stored skill list.
 * Returns an empty array (never null) when nothing is saved.
 * @returns {Promise<Array<object>>}
 */
export async function getSkills() {
  try {
    const stored = await chrome.storage.local.get(SKILLS_KEY);
    const s = stored?.[SKILLS_KEY];
    return Array.isArray(s) ? s : [];
  } catch {
    return [];
  }
}

/**
 * Validates and sanitises a raw skill object.
 * Returns { ok: true, data } or { ok: false, error }.
 * @param {object} raw
 * @returns {{ ok: true, data: object } | { ok: false, error: string }}
 */
export function validateSkill(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "A skill must be a plain object." };
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return { ok: false, error: "Skill name is required." };
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, error: `Skill name must be ${MAX_NAME_LEN} characters or fewer.` };
  }

  const description = typeof raw.description === "string" ? raw.description.trim().slice(0, MAX_DESC_LEN) : "";

  const kind = typeof raw.kind === "string" && ALLOWED_KINDS.has(raw.kind) ? raw.kind : "chat";

  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) return { ok: false, error: "Skill prompt is required." };
  if (prompt.length > MAX_PROMPT_LEN) {
    return { ok: false, error: `Skill prompt must be ${MAX_PROMPT_LEN} characters or fewer.` };
  }

  // Reject prompts containing javascript: or data: URLs (defensive import guard).
  if (/javascript\s*:/i.test(prompt) || /data\s*:/i.test(prompt)) {
    return { ok: false, error: "Skill prompt contains a disallowed URL scheme." };
  }

  const language = raw.language === "hinglish" ? "hinglish" : "en";

  return {
    ok: true,
    data: { name, description, kind, prompt, language }
  };
}

/**
 * Saves a new skill (or replaces one with the same id).
 * Generates a stable id when none is provided.
 * @param {object} raw  Unsanitised skill fields from the UI or import.
 * @returns {Promise<{ ok: true, data: object[] } | { ok: false, error: string }>}
 */
export async function saveSkill(raw) {
  const validation = validateSkill(raw);
  if (!validation.ok) return validation;

  const skills = await getSkills();
  if (skills.length >= MAX_SKILLS && !raw.id) {
    return { ok: false, error: `You can save at most ${MAX_SKILLS} skills. Delete one first.` };
  }

  const now = new Date().toISOString();
  const skill = {
    id: (typeof raw.id === "string" && raw.id.trim()) ? raw.id.trim() : crypto.randomUUID(),
    ...validation.data,
    createdAt: (typeof raw.createdAt === "string" && raw.createdAt) ? raw.createdAt : now,
    updatedAt: now
  };

  const idx = skills.findIndex((s) => s.id === skill.id);
  if (idx >= 0) {
    skills[idx] = skill;
  } else {
    skills.push(skill);
  }

  await chrome.storage.local.set({ [SKILLS_KEY]: skills });
  return { ok: true, data: skills };
}

/**
 * Deletes a skill by id.
 * Silently succeeds when the id is not found.
 * @param {string} id
 * @returns {Promise<object[]>} The updated list.
 */
export async function deleteSkill(id) {
  const skills = await getSkills();
  const next = skills.filter((s) => s.id !== id);
  await chrome.storage.local.set({ [SKILLS_KEY]: next });
  return next;
}

/**
 * Returns all skills serialised for download.
 * @returns {Promise<object[]>}
 */
export async function exportSkills() {
  return getSkills();
}

/**
 * Imports a skill list from an untrusted external file.
 *
 * Security:
 *  - `data` must be an array; anything else is rejected outright.
 *  - Each item is run through validateSkill; invalid items are skipped (not fatal).
 *  - Duplicate ids are de-duplicated by preferring the imported version.
 *  - Total count is capped at MAX_SKILLS after merge.
 *  - Never auto-runs anything — caller is responsible for any UI feedback.
 *
 * @param {unknown} data  Parsed JSON from the imported file.
 * @returns {Promise<{ ok: true, data: object[], imported: number, skipped: number }
 *                  | { ok: false, error: string }>}
 */
export async function importSkills(data) {
  if (!Array.isArray(data)) {
    return { ok: false, error: "The file must contain a JSON array of skills." };
  }

  const existing = await getSkills();
  const existingMap = new Map(existing.map((s) => [s.id, s]));

  let imported = 0;
  let skipped = 0;

  for (const raw of data) {
    const validation = validateSkill(raw);
    if (!validation.ok) { skipped++; continue; }

    const now = new Date().toISOString();
    const skill = {
      id: (typeof raw.id === "string" && raw.id.trim()) ? raw.id.trim() : crypto.randomUUID(),
      ...validation.data,
      createdAt: (typeof raw.createdAt === "string" && raw.createdAt) ? raw.createdAt : now,
      updatedAt: now
    };
    existingMap.set(skill.id, skill);
    imported++;
  }

  const merged = Array.from(existingMap.values()).slice(0, MAX_SKILLS);
  await chrome.storage.local.set({ [SKILLS_KEY]: merged });
  return { ok: true, data: merged, imported, skipped };
}

/* ─────────────────────────────────────────────────────────────────────────
   Starter skills  (Slice 4.2 — "ship starter skills")
   Seeded the very first time the panel loads when no skills exist.
   ───────────────────────────────────────────────────────────────────────── */

export const STARTER_SKILLS = [
  {
    id: "starter-exam-notes",
    name: "Exam notes",
    description: "Condense the page into concise revision bullet points.",
    kind: "summarise",
    prompt:
      "Summarise this page as concise exam revision notes. " +
      "Use short bullet points grouped by topic. " +
      "Start each bullet with a bold key term. " +
      "Omit navigation, ads, and filler text.",
    language: "en"
  },
  {
    id: "starter-explain-hinglish",
    name: "Explain in Hinglish",
    description: "Explain the selected text or page in easy Hinglish.",
    kind: "chat",
    prompt:
      "Explain the main idea of this page (or the highlighted text) in simple Hinglish " +
      "(Hindi written in the Latin alphabet mixed with English, e.g. 'Yeh concept basically yeh hai…'). " +
      "Do NOT use Devanagari script. Keep the explanation friendly and under 150 words.",
    language: "hinglish"
  },
  {
    id: "starter-reply-politely",
    name: "Reply to this email politely",
    description: "Draft a brief, polite reply to the selected email/message text.",
    kind: "draft",
    prompt:
      "Write a short, polite, and professional reply to the selected content. " +
      "2–3 sentences maximum. Do not add hashtags, links, or invented facts. " +
      "Output only the reply text, ready to send.",
    language: "en"
  },
  {
    id: "starter-fill-from-profile",
    name: "Fill this form from my profile",
    description: "Remind Sahayak to use your saved profile when filling a form.",
    kind: "chat",
    prompt:
      "Look at the interactive elements on this page. " +
      "Tell me which fields you can fill using the user profile (name, college, skills, links). " +
      "List each matched field as: 'Field label → profile value'. " +
      "Do not fill anything yet — just report the matches.",
    language: "en"
  }
];

/**
 * Seeds the starter skills into storage if no skills exist yet.
 * Safe to call on every panel open — it is a no-op when skills are already present.
 * @returns {Promise<void>}
 */
export async function seedStarterSkills() {
  const existing = await getSkills();
  if (existing.length > 0) return;

  const now = new Date().toISOString();
  const seeded = STARTER_SKILLS.map((s) => ({ ...s, createdAt: now, updatedAt: now }));
  await chrome.storage.local.set({ [SKILLS_KEY]: seeded });
}
