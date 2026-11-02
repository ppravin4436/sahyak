# Sahayak Implementation Plan

Phase-wise build plan for Sahayak. Use this with `docs/problemstatement.md` (product contract) and `docs/architecture.md` (system design).

**Rule:** ship vertical slices. Each slice leaves a loadable Chrome extension. Do not generate the whole product in one pass.

**Load unpacked root:** `extension/`

**Default stack:** vanilla JS ES modules, Manifest V3, Gemini Flash-Lite / Flash, Groq text fallback, Mozilla Readability.js.

---

## How to use this plan

1. Complete phases in order. Slices inside a phase are also ordered.
2. A slice is done only when its **exit checklist** passes on a real Chrome tab.
3. Do not start agent execution (Phase 3) until Phase 2 chat and error handling work.
4. Safety stubs exist early; full rails land in Phase 4 but **password/OTP typing must never ship even as a stub executor**.
5. Optional stretch work is marked **STRETCH** and must not delay the definition of done.

### Global conventions (apply from slice 0)

| Convention | Detail |
| --- | --- |
| Isolation | Side panel never touches DOM. Content scripts never hold API keys or call models. Service worker is the only model client. |
| Messages | Versioned envelope `{ v: 1, type, requestId, tabId?, payload }` |
| Storage | Keys and profile in `chrome.storage.local` only |
| Secrets | Never hard-code keys; `.gitignore` local secrets |
| Models | Untrusted. Parse/validate JSON in extension code before any action |
| Language | Generation-time English vs Hinglish, not post-translation |

### Suggested repo at start of Phase 1

```text
/
├── docs/problemstatement.md
├── docs/architecture.md
├── docs/implementation-plan.md
├── extension/          # created in Phase 1
├── landing/            # Phase 4
├── README.md           # stub in Phase 1, complete in Phase 4
└── .gitignore
```

---

## Phase 0 — Project bootstrap (half day)

**Goal:** empty repo is safe to fill; Chrome can later load `extension/`.

### Tasks

1. Add `.gitignore`: `*.pem`, `.env`, `**/secrets*`, `*.zip` if zips might contain keys, OS junk.
2. Add a one-paragraph `README.md` pointing at docs and saying “extension not built yet”.
3. Confirm Chrome desktop is available for Load unpacked testing.

### Exit checklist

- [ ] Repo has no API keys.
- [ ] Docs trio is the source of truth: problem, architecture, this plan.

---

## Phase 1 — The Eyes: Read the web (Week 1)

**Objective:** installable MV3 extension that opens a side panel, stores a Gemini key, explains selected text, summarises articles and public YouTube, and toggles English/Hinglish.

**Architecture refs:** §§3, 5, 6, 7.1–7.4, 11.

### Slice 1.1 — Extension shell + side panel + settings

**Product:** FR-1, FR-2. Cursor order item 1.

**Create**

| Path | Responsibility |
| --- | --- |
| `extension/manifest.json` | MV3, `sidePanel`, `action`, `storage`, `scripting`, host access as needed |
| `extension/background/sw.js` | Open side panel on action click; message stub |
| `extension/background/messages.js` | Envelope router (empty handlers OK) |
| `extension/sidepanel/index.html` | Shell UI: header, language toggle placeholder, main area, composer |
| `extension/sidepanel/panel.js` | Open/close sections; `chrome.runtime.sendMessage` |
| `extension/sidepanel/styles.css` | Readable desktop side-panel layout |
| `extension/options/index.html` | Gemini API key field, save/clear |
| `extension/options/options.js` | Read/write `settings` in `chrome.storage.local` |
| `extension/assets/` | Toolbar icons |

**Implement**

1. `action.onClicked` → `chrome.sidePanel.open({ windowId })`.
2. Options page saves `{ geminiApiKey }` without logging the value.
3. Side panel shows “Set API key in Settings” if key missing.

**Manual test**

- Load unpacked `extension/`.
- Pin the extension, open a news article, open the side panel beside the page.
- Save a dummy key, reload, confirm it persists (then replace with a real key for later slices).

**Exit checklist**

- [ ] Extension loads with no MV3 errors.
- [ ] Side panel opens next to a normal webpage.
- [ ] API key is entered in settings, not in source.

---

### Slice 1.2 — Gemini text call + explain selection

**Product:** first AI interaction. Cursor order items 2 (+ selection path).

**Create / extend**

| Path | Responsibility |
| --- | --- |
| `extension/background/ai/gemini.js` | REST generateContent for Flash-Lite |
| `extension/background/ai/prompts.js` | `explainSelection` template + language |
| `extension/content/reader.js` | Return `{ title, url, selection, heading? }` |
| `extension/sidepanel/*` | “Explain selection” button + result pane |

**Implement**

1. Inject or message `reader.js` for current tab selection.
2. SW reads key from storage, calls Gemini, returns text to panel.
3. Empty selection → tell the user to highlight text first.
4. Invalid key → friendly error, no crash.

**Manual test**

- Highlight a jargon paragraph on a public article.
- Explain it in the side panel in English.

**Exit checklist**

- [ ] Selected text is explained by the model in the side panel.
- [ ] Content script does not contain the API key.

---

### Slice 1.3 — Article extraction and structured summary

**Product:** FR-3, FR-4. Cursor order item 3.

**Create / extend**

| Path | Responsibility |
| --- | --- |
| `extension/lib/Readability.js` | Vendored Mozilla Readability |
| `extension/content/reader.js` | Run Readability; fallback to `article`/`main` text |
| `extension/background/ai/prompts.js` | Summary schema: TL;DR, five points, what next |
| `extension/background/safety/urls.js` | Stub `canSendToModel(url)` returning true except obvious `chrome://` |

**Implement**

1. `GET_PAGE_CONTEXT` returns extracted text, truncated to the architecture cap (~24–32k chars).
2. `SUMMARISE_PAGE` uses Flash-Lite; render structured summary in the panel.
3. If extraction is empty, show the architecture fallback copy (try selection or later screenshot).

**Manual test**

- Summarise a long public news/blog article.
- Confirm nav/ads are mostly absent from the model input (spot-check extracted length vs full `innerText`).

**Exit checklist**

- [ ] Summary has one-line TL;DR, five key points, what to do next.
- [ ] Readability runs in the content script on the live document.

---

### Slice 1.4 — Public YouTube summary

**Product:** YouTube path. Cursor order item 4.

**Extend** `gemini.js`, `prompts.js`, panel.

**Implement**

1. Detect `youtube.com/watch` and `youtu.be` public links.
2. Send the **URL** to Gemini video/public-link input (Flash), not scraped captions.
3. Ask for chapter-style `{ t, title, note }[]` plus overall summary.
4. Render timestamps as `https://www.youtube.com/watch?v=ID&t=SECONDS`.
5. Private/unsupported → explicit “unsupported or private video” state.

**Manual test**

- Open a well-known public talk/video; summarise; click a timestamp and confirm the tab seeks.

**Exit checklist**

- [x] Supported public YouTube link produces a useful structured summary.
- [x] No caption-scraping fallback.

---

### Slice 1.5 — English / Hinglish toggle

**Product:** language toggle. Cursor order item 5.

**Implement**

1. Persist `settings.preferredLanguage`: `en` | `hinglish`.
2. Every prompt includes the architecture language instruction (Hinglish = Hindi in Latin script mixed with English).
3. Toggle re-runs the **last generation** (summary or last explain), not the entire unused history.

**Manual test**

- Same article: English summary, then Hinglish; both structured.

**Exit checklist**

- [x] English/Hinglish switching works on explain and summary.

---

### Phase 1 acceptance gate (must all pass)

- [x] Extension loads in Chrome.
- [x] Side panel opens next to a webpage.
- [x] API key via settings, not hard-coded.
- [x] Selected text can be explained.
- [x] Article summarises into the required structure.
- [x] Supported public YouTube can be summarised.
- [x] English/Hinglish switching works.

**STRETCH (do not block Week 2):** Chrome built-in summarizer behind a settings toggle; fail open to Gemini.

---

## Phase 2 — The Brain: Understand page and screen (Week 2)

**Objective:** grounded page chat, right-click actions, screenshot-and-ask, free-tier resilience.

**Architecture refs:** §§7.5–7.8, 11, 15.

### Slice 2.1 — Grounded page chat

**Product:** FR-5. Cursor order item 6.

**Create / extend**

| Path | Responsibility |
| --- | --- |
| `extension/sidepanel/` | Chat thread UI, composer, streaming placeholders |
| `extension/background/` | `CHAT_TURN`; assemble `{ title, url, extractedText, selection? }` + last N turns |
| Storage | `chat.thread` in `chrome.storage.session` |

**Implement**

1. System rules: answer only from page context; admit when missing; do not invent.
2. Cap history tokens; truncate page text the same as summary.
3. Stream via `CHAT_DELTA` if Gemini streaming is available; else single `CHAT_DONE`.
4. Abort in-flight turn if the panel closes or the user sends another message.

**Manual test**

- Ask a fact that is on the page → cited from page language.
- Ask something absent → “not on this page” (or equivalent), not a hallucination.

**Exit checklist**

- [ ] Chat uses current page as source of truth.
- [ ] Conversation history kept for the active interaction.
- [ ] Missing answers are admitted.

---

### Slice 2.2 — Context-menu actions

**Product:** Explain, Translate, Draft a reply. Cursor order item 7.

**Implement**

1. On install, register `sahayak_explain`, `sahayak_translate`, `sahayak_draft`.
2. `contextMenus.onClicked` → open side panel → `CONTEXT_ACTION` with `selectionText` + URL.
3. Translate target from settings (Hindi or selected language).
4. Draft uses tone from settings (profile hook can wait until Phase 4; empty profile is fine).

**Manifest:** add `contextMenus` permission.

**Manual test**

- Right-click selected text on an article, LinkedIn-style post, or forum thread; result appears in the panel for all three actions.

**Exit checklist**

- [ ] Explain, Translate, Draft work from the right-click menu and land in the side panel.

---

### Slice 2.3 — Screenshot-and-ask

**Product:** FR-6. Cursor order item 8.

**Create / extend**

| Path | Responsibility |
| --- | --- |
| Panel crop UI | Canvas overlay on captured PNG |
| `gemini.js` | Multimodal Flash request |
| Manifest | `tabs` (or equivalent) for `captureVisibleTab` |

**Implement**

1. User clicks Capture → SW `chrome.tabs.captureVisibleTab`.
2. Panel shows image; user can crop before send.
3. User question + cropped image → Gemini Flash (not Groq).
4. If URL later blocked by safety, refuse capture (wire stub: block `chrome:` and file URLs now).

**Manual test**

- Chart, error dialog, or form that is not in Readability text; ask a question about the visible region.

**Exit checklist**

- [ ] User can ask a question about a visible screenshot.
- [ ] Crop happens before the model call.

---

### Slice 2.4 — API error handling and fallback

**Product:** free-tier resilience. Cursor order item 9.

**Create**

| Path | Responsibility |
| --- | --- |
| `extension/background/ai/router.js` | Task class → model; 429/503 backoff; Groq fallback |
| `extension/background/ai/groq.js` | Text-only completions |
| Options | Optional Groq API key |

**Router policy (architecture §11.1)**

| Task | Default | Escalate | Fallback |
| --- | --- | --- | --- |
| Explain, translate, draft, article summary, chat | Flash-Lite | Flash after quality/repair miss | Groq if text |
| Screenshot / YouTube | Flash | — | User-visible error |
| Later agent JSON | Flash-Lite | Flash after invalid JSON | Groq JSON if needed |

**Implement**

1. Detect 429/503; backoff 1s, 2s, 4s; max 3 tries; **retry HTTP only, never DOM mutations**.
2. Persistent text failure → Groq if key present.
3. Panel error states: invalid key, rate limit, network, blocked page — never an uncaught crash.

**Manual test**

- Temporarily wrong Gemini key → clear error.
- If possible, trigger 429 or simulate in the adapter → retry copy then fallback or final error.

**Exit checklist**

- [ ] Model errors and rate limits do not crash the extension.
- [ ] Lighter model is default; Flash used for vision.

---

### Phase 2 acceptance gate

- [ ] User can chat with the current page.
- [ ] Answers stay grounded; missing info is admitted.
- [ ] Explain, Translate, Draft work from the context menu.
- [ ] Screenshot questions work.
- [ ] Rate limits / API errors fail gracefully.

---

## Phase 3 — The Hands: Act with user approval (Week 3)

**Objective:** numbered interactive map, Find It, one-step agent loop, controls, persistence, practice errands.

**Architecture refs:** §8, §13.2. **FR-7, FR-8.**

**Hard rule:** no `click`/`type`/`select` without a user decision in the panel. Dry-run never mutates.

### Slice 3.1 — Scanner and badges

**Product:** interactive element scanner + overlay. Cursor order item 10.

**Create**

| Path | Responsibility |
| --- | --- |
| `extension/content/scanner.js` | Query buttons, links, inputs, textareas, selects, checkboxes, supported roles |
| `extension/content/overlay.js` | Shadow DOM numbered badges; `pointer-events: none` |
| Panel | “Scan page” / agent section scaffolding |

**Implement**

1. Visibility filters; skip overlay nodes; dedupe label vs control.
2. Assign 1-based `n` for `scanGeneration` (increment every scan).
3. Emit compact `ActionNode[]` (architecture §8.1); **never send innerHTML to the model**.
4. Cap list (80–120); prefer viewport-visible; note truncation.
5. Mark `sensitive` and `consequential` flags using field/verb heuristics (full lists in Phase 4; password types flagged now).

**Manual test**

- Practice form: badges overlay correctly; indices match the JSON preview in the panel.

**Exit checklist**

- [ ] Interactive elements detected and numbered on supported pages.
- [ ] Overlay uses shadow DOM.

---

### Slice 3.2 — Find It for Me (structured element selection)

**Product:** natural language → element highlight, no auto-click. Cursor order item 11.

**Create** `extension/background/agent/schemas.js` — find-it JSON:

```json
{ "n": 17, "confidence": "high", "reason": "File input labelled Resume" }
```

**Implement**

1. Scan + badges on.
2. Model returns JSON only; validate; one repair retry.
3. `HIGHLIGHT_ELEMENT`; **do not click**.
4. Stale `n` or generation mismatch → rescan, do not guess.

**Manual test**

- “Where do I upload my resume?” on a practice form highlights the file input.

**Exit checklist**

- [ ] Correct element identified from a natural-language request.
- [ ] Response is strict JSON; no navigation action runs.

---

### Slice 3.3 — Approval-based agent loop

**Product:** FR-7, FR-8. Cursor order item 12.

**Create**

| Path | Responsibility |
| --- | --- |
| `extension/background/agent/loop.js` | Perceive → propose → wait → execute → loop |
| `extension/content/executor.js` | `click`, `type`, `select`, `scroll`, `done` |
| Panel | Proposal card: type, target, value, reason; Approve / Skip / Stop |

**Action schema** (`click` \| `type` \| `select` \| `scroll` \| `done`) with `n`, `value`, `reason` as specified.

**Loop**

1. Read page + action map.
2. Ask model for **one** next action JSON.
3. Validate schema; resolve node; generation check.
4. Show proposal + highlight; **wait**.
5. Approve → execute exactly that action → new snapshot.
6. Skip → ask for a different action (log skip).
7. Stop → end session.
8. `done` or max steps → finish.

**Executor guards (minimum this slice)**

- Refuse `type` into `input[type=password]`.
- Refuse execute if `scanGeneration` mismatch.
- Re-check tab URL before mutate.

**Manual test**

- One approved click and one approved type on a practice page.
- Confirm nothing happens until Approve.

**Exit checklist**

- [ ] Next action is strict JSON.
- [ ] No browser action before approval.
- [ ] Approve / Skip / Stop work.

---

### Slice 3.4 — Persistence, dry-run, step limits, action log

**Product:** agent controls. Cursor order item 13.

**Create** `extension/background/agent/session.js`

Persist `AgentSession` (architecture §8.6) in `chrome.storage.session` with local fallback **before every wait**.

**Implement**

1. `maxSteps` from settings (sensible default, e.g. 20).
2. Dry-run: Approve highlights only; log `dry-run`; no DOM write.
3. On SW wake, rebroadcast `AGENT_STATE`; **never auto-execute** `pendingAction`.
4. Action log: step, proposed action, reason, decision, timestamp; show in panel.
5. Pass a short digest of recent skip/approve to the model so it does not repeat skipped steps.

**Manual test**

- Pause on approval, wait for SW idle (or terminate SW in `chrome://serviceworker-internals`), reopen panel: proposal still there, Approve still required.
- Dry-run a click: highlight only.
- Hit max steps: session ends cleanly.
- Log shows proposed vs decision.

**Exit checklist**

- [ ] Step limit, dry-run, Stop work.
- [ ] Progress survives service-worker sleep.
- [ ] Action log preserved for the task.

---

### Slice 3.5 — Practice errands

**Product:** at least two controlled tasks.

**Create** `extension/test-pages/` (or a documented practice URL list in `safety/urls.js`):

1. Multi-step internship-style form.
2. Mini shop: search + filter.
3. Optional: two pages of facts to collect into a panel table.

**Implement**

1. Agent start allowed only on practice origins this week (owned-origins UI in Phase 4).
2. Walk each errand with approval every step.
3. Fix scanner misses (hidden file inputs, custom dropdowns) only as needed for these pages.

**Exit checklist**

- [ ] Sahayak completes **at least two** practice errands with approval at every step.

---

### Phase 3 acceptance gate

- [ ] Numbering reliable on supported pages.
- [ ] Find It highlights without acting.
- [ ] Strict JSON actions.
- [ ] No action before approval.
- [ ] Approve, Skip, Stop, step limit, dry-run work.
- [ ] Session survives SW sleep.
- [ ] Action log preserved.
- [ ] Two practice errands succeed.

---

## Phase 4 — Memory, safety, and shipping (Week 4)

**Objective:** local profile, skills, deterministic safety, public install package.

**Architecture refs:** §§9–10, 12, 16–19.

### Slice 4.1 — Local profile memory

**Product:** FR-9. Cursor order item 14.

**Storage** `profile`: name, college, skills, links, preferred language, preferred tone.

**Implement**

1. Settings or panel editor; local only.
2. Inject profile snippet into Draft prompts.
3. For agent `type`, allow filling from profile **only** if the node is not sensitive; show the exact value on the proposal card; user still Approves.
4. Never send profile to a blocked page (depends on 4.3).

**Exit checklist**

- [ ] Profile works locally for drafts and supported form fills.

---

### Slice 4.2 — Saved skills import/export

**Product:** one-click skills. Cursor order item 15.

**Skill shape:** `id`, `name`, `description`, `kind` (`summarise` \| `chat` \| `agent` \| `draft`), `prompt`, optional `language`.

**Ship starter skills**

- Exam notes
- Explain in Hinglish
- Reply to this email politely
- Fill this form from my profile

**Implement**

1. Run skill = current page context + skill.prompt (+ profile if requested).
2. Export/import JSON via download / file input; schema-validate; reject unexpected executables or remote URLs in the file.

**Exit checklist**

- [ ] Skills can be created, reused, exported, and imported.

---

### Slice 4.3 — Safety rails in code

**Product:** FR-10. Cursor order item 16.

**Create / finish**

| Path | Responsibility |
| --- | --- |
| `safety/urls.js` | Banking, payment, UPI hosts/path heuristics; practice allowlist; `ownedOrigins` |
| `safety/fields.js` | Password, OTP, card, `autocomplete` cc-* / one-time-code |
| `safety/consequential.js` | Submit / Pay / Send extra confirm |

**Pipeline (must run before model send and before DOM write)**

1. Classify URL → block agent + remote payload on sensitive pages.
2. Classify payload → do not send private email/bank/personal-doc pages.
3. Agent origin must be practice **or** user-owned opt-in.
4. Validate JSON → resolve node → field guards → extra confirm → execute.
5. Kill switch already from Phase 3; verify it ignores in-flight model results.

**Do not automate:** logins, payments, OTP.

**Manual safety drills**

- Mock checkout / UPI-like URL → block, no capture, no extract upload.
- Password and OTP fields → `type` refused even if the model asks.
- Submit button → second confirmation after Approve.
- Confirm API keys still absent from git.

**Exit checklist**

- [ ] Restricted pages and protected fields blocked in **code**.
- [ ] Consequential actions need extra confirmation.
- [ ] Stop always visible during a session.
- [ ] Keys not in the repository.

---

### Slice 4.4 — README, release, landing page

**Product:** public packaging. Cursor order item 17.

**Create**

| Path | Responsibility |
| --- | --- |
| `README.md` | What Sahayak is, Load unpacked, get Gemini key, usage, safety, out of scope |
| Screenshots | Panel summary, chat, badges + approval, settings **with keys hidden** |
| GitHub Release | Zip of `extension/` only |
| `landing/` | One-page GitHub Pages: pitch, screenshots, link to release |

**README must include**

- Chrome desktop, Load unpacked path `extension/`
- Options: paste user’s own API key
- English/Hinglish, chat, context menus, screenshot, agent approval
- Practice pages / owned origins
- What it will never do (passwords, OTP, payments, autonomous run)

**Exit checklist**

- [ ] Another user can install from the release ZIP.
- [ ] Setup and usage are clear.
- [ ] Simple public landing page exists.

---

### Phase 4 acceptance gate

- [ ] Local profile memory works.
- [ ] Skills create/reuse/import/export work.
- [ ] Restricted pages/fields blocked.
- [ ] Extra confirm on consequential actions.
- [ ] API key not committed.
- [ ] Install from release package works.
- [ ] Docs complete; landing page live.

---

## Definition of done (end of Phase 4)

A new user installs from the GitHub Release, enters their API key, opens the side panel on a supported page, and completes:

1. Summarise an article or supported public YouTube link.
2. Switch English / Hinglish.
3. Chat with the current page.
4. Explain, Translate, or Draft from selected text.
5. Ask about visible screen content.
6. Find a relevant interactive element.
7. Give a supported browser task.
8. Review and approve each step.
9. Stop or skip at any time.
10. Review the action log.
11. Reuse local profile data and a saved skill.
12. Confirm protected pages, fields, and actions are blocked.

If any item fails, the corresponding slice is not done — fix before calling the project complete.

---

## Cross-cutting work (do not treat as a fifth week)

| Concern | When | Notes |
| --- | --- | --- |
| Message envelope | Slice 1.1 onward | Add types as features land; do not rewrite the protocol |
| Truncation / token caps | 1.3, 2.1, 3.1 | Keep model context compact |
| JSON parse + one repair | 3.2, 3.3 | Strip a single fence; schema fail → error, never guess |
| SW sleep | 3.4 | Persist before every user wait |
| Unit tests | From 3.2 / 4.3 | Schema, URL/field safety, JSON stripping — see architecture §16 |
| Practice HTML fixtures | 3.1–3.5 | Scanner numbering tests |

---

## Suggested calendar (4 weeks)

Assume ~5 working days per week. Adjust, but keep gate order.

| Days | Slices | Outcome |
| --- | --- | --- |
| 1 | 0, 1.1 | Loadable shell + settings |
| 2 | 1.2, 1.3 | Explain + article summary |
| 3–4 | 1.4, 1.5 | YouTube + language; **Phase 1 gate** |
| 5–6 | 2.1, 2.2 | Chat + context menus |
| 7–8 | 2.3, 2.4 | Vision + router; **Phase 2 gate** |
| 9–10 | 3.1, 3.2 | Scanner + Find It |
| 11–13 | 3.3, 3.4 | Loop + persistence |
| 14 | 3.5 | Two errands; **Phase 3 gate** |
| 15–16 | 4.1, 4.2 | Profile + skills |
| 17 | 4.3 | Safety drills |
| 18–20 | 4.4 + DoD pass | Ship ZIP + Pages; **Phase 4 gate** |

---

## Risk register

| Risk | Phase | Mitigation |
| --- | --- | --- |
| Gemini YouTube API shape differs | 1.4 | Feature-detect; clear unsupported state; do not scrape |
| Readability fails on SPAs | 1.3 | Fallback to `main`/`article`; chat still works; screenshot in 2.3 |
| Custom widgets not in scanner | 3.1 | Cover practice pages first; expand selectors only when a practice task needs them |
| Stale element indices | 3.3 | `scanGeneration`; rescan on mismatch |
| SW kills in-flight fetch | 3.4 | Persist session; user re-approves; no auto-click |
| Free-tier 429 during demos | 2.4 | Flash-Lite default, backoff, Groq text fallback |
| Over-broad host permissions | 1.1 / 4.3 | Tighten where possible; agent allowlist in code regardless |
| Safety only in prompts | 4.3 | Executor + URL checks are mandatory; prompt is duplicate, not control |

---

## Out of scope (do not schedule)

- Chrome on Android / iPhone
- Autonomous multi-step run without approval
- Banking, payment, login, OTP, password, or card automation
- Chrome Web Store listing
- Acting on arbitrary third-party sites for risky workflows
- Sending private email, bank, or personal-document pages to free-tier models

**STRETCH only after DoD:** on-device Chrome summarizer.

---

## Implementation order (canonical)

Same as problem statement §10; this plan’s slice IDs:

1. `1.1` Extension shell + side panel + settings  
2. `1.2` Gemini text call (explain selection)  
3. `1.3` Article extraction and summary  
4. `1.4` Public YouTube summary  
5. `1.5` English/Hinglish toggle  
6. `2.1` Grounded page chat  
7. `2.2` Context-menu actions  
8. `2.3` Screenshot-and-ask  
9. `2.4` API error handling and fallback  
10. `3.1` Interactive element scanner and badges  
11. `3.2` Structured element selection (Find It)  
12. `3.3` Approval-based agent loop  
13. `3.4` Persistence, dry-run, step limits, action logs  
14. `4.1` Local profile memory  
15. `4.2` Saved skills import/export  
16. `4.3` Safety rails  
17. `4.4` README, release packaging, landing page  

For each slice: smallest working version → test on real supported pages → then the next slice.
