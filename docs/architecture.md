# Sahayak Architecture

Sahayak is a Chrome Manifest V3 side-panel agent. It reads the current tab, reasons over compact page context, and performs browser actions only after the user approves each step.

This document is the implementation blueprint for `docs/problemstatement.md`. It describes components, message flows, data models, model routing, the approval agent loop, and safety enforcement in code.

---

## 1. Goals and constraints

### 1.1 Product goals

- Understand the current page (article text, YouTube public links, visible screen).
- Answer only from page context; admit when the page does not contain the answer.
- Map interactive elements to numbered actions the model can reason about.
- Execute `click`, `type`, `select`, `scroll`, and `done` only after explicit approval.
- Store profile and skills locally; never commit API keys.
- Ship as an unpackable GitHub Release ZIP plus a GitHub Pages landing page.

### 1.2 Non-goals (core build)

- Autonomous multi-step execution without approval.
- Login, OTP, password, card, banking, or payment automation.
- Mobile Chrome, Chrome Web Store publication.
- Acting on arbitrary third-party sites for consequential workflows.

### 1.3 Hard constraints

| Constraint | Architectural response |
| --- | --- |
| MV3 service worker can sleep | Persist agent session state in `chrome.storage.session` / `chrome.storage.local` before every wait |
| Models are untrusted | Parse and validate JSON in extension code; never execute raw model output |
| Safety must not rely on prompts | Deterministic allow/block in content script + background before any DOM write |
| Free-tier APIs | Default Gemini Flash-Lite; escalate Flash for vision/hard reasoning; Groq text fallback; retry on 429 |
| Privacy | Do not send blocked/sensitive page payloads to remote models |

---

## 2. System context

```text
┌─────────────────────────────────────────────────────────────────┐
│                         User (Chrome desktop)                   │
│  Side panel  ·  Context menus  ·  Approve / Skip / Stop         │
└───────────────┬─────────────────────────────┬───────────────────┘
                │ chrome.* APIs               │ DOM
┌───────────────▼──────────────┐   ┌──────────▼───────────────────┐
│  Sahayak extension (MV3)     │   │  Current tab page            │
│  background · sidepanel ·    │◄──┤  content script + overlay    │
│  options · content scripts   │   │  Readability + action map    │
└───────────────┬──────────────┘   └──────────────────────────────┘
                │ HTTPS (user API keys)
    ┌───────────┼────────────┐
    ▼           ▼            ▼
 Gemini     Gemini Flash   Groq
 Flash-Lite  (vision /     (text fallback)
             harder tasks)
    │
    └── Gemini YouTube public-link input (supported public videos only)
```

Sahayak never talks to the page’s origin as a backend. All page access is through extension content scripts injected by the user-installed extension.

---

## 3. Extension topology (Manifest V3)

### 3.1 Runtime pieces

| Piece | Role | Lifetime |
| --- | --- | --- |
| `background/service-worker` | Message hub, API orchestration, context menus, tab capture, agent session persistence, safety gate | Ephemeral; may suspend |
| `sidepanel/` | Primary UI: chat, summary, agent controls, action log, language toggle, skills | Lives while panel is open |
| `options/` or settings view in panel | Gemini/Groq keys, language, tone, model preferences | User-initiated |
| `content/page-reader` | Readability extraction, selected text, DOM snapshot for chat | Per tab, on demand |
| `content/scanner` | Interactive element scan, numbered badges, highlight, execute approved actions | Per tab during agent / find-it |
| `content/overlay` | Number badges, highlight ring, dry-run preview | Overlay on page |
| Offscreen document (optional) | Only if screenshot crop or clipboard needs a DOM; avoid unless required | Short-lived |

### 3.2 Manifest capabilities (required)

- `sidePanel` + `action` to open the panel on the active tab.
- `scripting`, `activeTab` / host access for extraction and agent execution on allowed pages.
- `storage` for keys, profile, skills, logs, agent checkpoints.
- `contextMenus` for Explain / Translate / Draft a reply.
- `tabs` for `captureVisibleTab` (screenshot-and-ask).
- Host permissions limited as much as possible; agent execution further gated by a practice/owned-page policy in code.

### 3.3 Isolation rules

- **Side panel** never touches the page DOM directly.
- **Content scripts** never hold API keys and never call Gemini/Groq.
- **Service worker** is the only process that sends page-derived payloads to models, after safety checks.
- **Options** write keys to `chrome.storage.local` (`sync` is not used for secrets).

---

## 4. Logical architecture

Sahayak is four layers with a fifth cross-cutting safety layer.

```text
┌──────────────────────────────────────────────────────────────┐
│ Presentation                                                 │
│ Side panel UI · options · context menus · page overlay       │
└────────────────────────────┬─────────────────────────────────┘
                             │ typed messages
┌────────────────────────────▼─────────────────────────────────┐
│ Application services (background)                            │
│ Chat · Summarise · YouTube · Vision · Agent orchestrator     │
│ Skills runner · Profile assembler                            │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌──────────────┬─────────────┴──────────────┬──────────────────┐
│ Perception   │ Decision                   │ Actuation        │
│ Extractors,  │ Model router,              │ Executor +       │
│ scanner,     │ JSON schemas,              │ user approval    │
│ screenshots  │ grounded prompts           │ gate             │
└──────────────┴──────────────┬─────────────┴──────────────────┘
                              │
┌─────────────────────────────▼────────────────────────────────┐
│ Platform                                                     │
│ chrome.storage · chrome.scripting · captureVisibleTab        │
│ Gemini / Groq adapters · Readability.js                      │
└──────────────────────────────────────────────────────────────┘
        ▲
        │ Safety rails (URL, field type, consequential verbs,
        │ payload redaction, kill switch) applied before
        │ model send AND before DOM mutation
```

### 4.1 Perception

Turns the tab into compact, model-ready context.

- **Article extractor:** Mozilla Readability on the page document; fallback to main/`article` text if Readability fails.
- **Selection extractor:** `window.getSelection()` plus surrounding heading if available.
- **YouTube detector:** If hostname is YouTube and the URL is a public watch/share link, pass the URL to Gemini’s public YouTube input; do not scrape private or login-walled videos.
- **Action map builder:** Query interactive elements, assign stable indices for the current DOM generation, emit compact JSON (not HTML).
- **Vision capture:** `chrome.tabs.captureVisibleTab` → optional user crop in the side panel → image part for Gemini Flash.

### 4.2 Decision

- Prompts are task-specific templates (summarise, chat, select-element, next-action).
- Structured tasks require JSON matching a Zod (or equivalent) schema.
- Invalid JSON → one repair retry → user-visible error; never guess an action.

### 4.3 Actuation

- User sees proposed action + reason + target highlight.
- `Approve` / `Skip` / `Stop` / extra confirm for consequential actions.
- Content-script executor performs one DOM operation, then returns a new perception snapshot.

---

## 5. Recommended repository layout

Keep the extension loadable from `extension/` so `chrome://extensions` → Load unpacked points at that folder.

```text
/
├── docs/
│   ├── problemstatement.md
│   └── architecture.md          ← this file
├── extension/
│   ├── manifest.json
│   ├── background/
│   │   ├── sw.js                # service worker entry
│   │   ├── messages.js          # message routing
│   │   ├── agent/
│   │   │   ├── loop.js          # one-step orchestrator
│   │   │   ├── session.js       # persist / restore
│   │   │   └── schemas.js       # action + find-it JSON
│   │   ├── ai/
│   │   │   ├── router.js        # Flash-Lite / Flash / Groq
│   │   │   ├── gemini.js
│   │   │   ├── groq.js
│   │   │   └── prompts.js
│   │   └── safety/
│   │       ├── urls.js
│   │       ├── fields.js
│   │       └── consequential.js
│   ├── sidepanel/
│   │   ├── index.html
│   │   ├── panel.js
│   │   └── styles.css
│   ├── options/
│   │   ├── index.html
│   │   └── options.js
│   ├── content/
│   │   ├── reader.js
│   │   ├── scanner.js
│   │   ├── executor.js
│   │   └── overlay.js
│   ├── lib/
│   │   └── Readability.js
│   └── assets/
├── landing/                     # GitHub Pages
├── README.md
└── .gitignore                   # .env, keys, zip secrets
```

Build tooling is optional. Prefer vanilla JS + ES modules in the service worker if bundling is not needed in week 1. Introduce a bundler only if module loading or Readability packaging becomes painful.

---

## 6. Message protocol

All runtime communication uses `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage` with a versioned envelope.

```ts
type Envelope<T = unknown> = {
  v: 1;
  type: MessageType;
  requestId: string;
  tabId?: number;
  payload: T;
};
```

### 6.1 Message types

| Type | Direction | Purpose |
| --- | --- | --- |
| `GET_PAGE_CONTEXT` | panel → SW → content | Readability + title + URL + selection |
| `SUMMARISE_PAGE` | panel → SW | Article or YouTube summary |
| `CHAT_TURN` | panel → SW | Grounded Q&A with history |
| `CONTEXT_ACTION` | SW → panel | Explain / Translate / Draft from menu |
| `CAPTURE_VISIBLE` | panel → SW | Screenshot PNG data URL |
| `SCAN_ELEMENTS` | panel → SW → content | Build action map + badges |
| `FIND_ELEMENT` | panel → SW | Natural language → element index JSON |
| `HIGHLIGHT_ELEMENT` | SW → content | Focus badge without acting |
| `AGENT_START` | panel → SW | Begin task with goal + limits |
| `AGENT_PROPOSE` | SW → panel | Next action for approval UI |
| `AGENT_DECISION` | panel → SW | approve / skip / stop / extraConfirm |
| `AGENT_EXECUTE` | SW → content | Single validated action |
| `AGENT_STATE` | SW → panel | Restored session, log, dry-run flag |
| `SAFETY_BLOCK` | SW → panel | User-readable block reason |

Content scripts reply with `{ ok: true, data }` or `{ ok: false, error }`. The service worker never assumes the tab is still the same; it re-reads `tabId` and URL before execute.

---

## 7. Feature architectures

### 7.1 Side panel and settings (FR-1, FR-2)

- Toolbar action opens `chrome.sidePanel` for the active window.
- Panel tabs or sections: **Chat**, **Summary**, **Agent**, **Skills**, **Log**.
- Settings: Gemini API key, optional Groq key, output language (English | Hinglish), draft tone, dry-run default, max agent steps.
- Keys stored as `settings.geminiApiKey`, `settings.groqApiKey` in `chrome.storage.local`.
- UI never logs key values.

### 7.2 Article summarisation (FR-3, FR-4)

```text
User → Summarise
  → GET_PAGE_CONTEXT (Readability text, title, url)
  → safety.canSendToModel(url, classification)
  → router.complete({ task: "summarise", model: flash-lite })
  → structured markdown/JSON:
       tldr, keyPoints[5], nextAction
  → render in panel; language from settings
```

Readability runs in the content script on the live document (correct DOM, not `fetch` of HTML, which would miss client-rendered content).

Token budget: truncate extracted text to a configured character cap (e.g. 24–32k chars) with a note that the model saw a truncated article.

### 7.3 Public YouTube summarisation

```text
If url is youtube.com/watch or youtu.be public link
  → Gemini with file/video URI input (public)
  → ask for chapter-style notes { t, title, note }[]
  → panel renders timestamps as links: youtube.com/watch?v=...&t=SECONDS
Else
  → user-visible “unsupported or private video”
```

Private, members-only, or age-gated videos are out of scope; do not fall back to scraping captions.

### 7.4 Language toggle

Language is a **generation parameter**, not a post-translation of English. Every prompt includes:

`Respond in {English|Hinglish}. Hinglish means Hindi in Latin script mixed with English, not Devanagari unless the user selected Hindi translate.`

Changing the toggle re-runs the last generation task (summary or last chat answer), not the whole history, unless the user asks to redo the thread.

### 7.5 Grounded page chat (FR-5)

System rules (enforced in the prompt **and** in UI copy):

1. Use only `pageContext` + this conversation.
2. If missing, say the page does not contain that information.
3. Do not browse or invent URLs.

Context assembly:

```text
{ title, url, extractedText, selection?, actionMapSummary? }
+ last N chat turns (store in session, cap tokens)
```

Streaming: if the Gemini SDK/HTTP stream is available, the SW forwards `CHAT_DELTA` chunks to the panel. If not, send a single `CHAT_DONE`. Either path must handle abort on panel close.

### 7.6 Context-menu actions

On install, register:

- `sahayak_explain`
- `sahayak_translate`
- `sahayak_draft`

Flow: `onClicked` → open side panel → `CONTEXT_ACTION` with `selectionText` + page URL → generate → show in panel. Translate target language comes from settings (Hindi or user-selected). Draft uses profile name/tone when present.

### 7.7 Screenshot-and-ask (FR-6)

```text
User clicks Capture
  → captureVisibleTab (active tab, PNG)
  → panel shows image + crop overlay (canvas)
  → user types question
  → Gemini Flash (vision), not Groq
  → answer in panel
```

Cropping happens **before** upload to reduce pixels and focus the model. Do not capture if URL is in the sensitive blocklist; show `SAFETY_BLOCK`.

### 7.8 Free-tier resilience

`ai/router.js`:

1. Classify task: `text-light` | `text-hard` | `vision` | `youtube`.
2. Primary: Gemini Flash-Lite for `text-light`; Flash for `text-hard`, `vision`, `youtube`.
3. On HTTP 429 / 503: exponential backoff (e.g. 1s, 2s, 4s), max 3 tries.
4. On persistent text failure: Groq if key present and task is text-only.
5. Surface a friendly error: rate limit, invalid key, blocked page, network.

Never retry mutations. Only HTTP calls to models are retried.

---

## 8. Agent architecture (Week 3)

This is the core control loop. The model proposes; the extension decides whether the proposal is legal; the user decides whether it runs.

### 8.1 Interactive element scanner

Content script `scanner.js` queries, at minimum:

- `a[href]`, `button`, `[role=button]`, `input:not([type=hidden])`, `textarea`, `select`, `[role=checkbox]`, `[role=combobox]`, `summary`, `[onclick]` (conservative), `label` associated controls.

Filters:

- Visible (not `display:none`, zero size, or `aria-hidden` unless still focusable).
- Not in the Sahayak overlay itself.
- Deduplicate by control identity (prefer native control over wrapping label).

Each element gets:

```ts
type ActionNode = {
  n: number;                 // 1-based index for this scan generation
  tag: string;
  role?: string;
  type?: string;             // input type
  name?: string;
  id?: string;
  text: string;              // accessible name, truncated
  placeholder?: string;
  href?: string;             // origin+path only, no secrets in query if possible
  disabled: boolean;
  sensitive: boolean;        // password, otp, card — never typed
  consequential: boolean;    // submit/pay/send heuristics
  bbox: { x: number; y: number; w: number; h: number };
};
```

**Stability:** `n` is valid only for `scanGeneration` (incremented on each scan). Execute must check `generation` matches; if the DOM changed, rescan and ask the model again instead of clicking a stale index.

Overlay: numbered badges at `bbox` using a shadow-DOM overlay so page CSS cannot steal clicks from the page incorrectly; badges are pointer-events none except during find-it highlight.

### 8.2 Compact action map (what the model sees)

Do **not** send innerHTML. Send:

```json
{
  "url": "https://practice.example/apply",
  "title": "Internship apply",
  "scanGeneration": 4,
  "nodes": [
    { "n": 1, "tag": "input", "type": "text", "text": "Full name" },
    { "n": 12, "tag": "button", "text": "Next", "consequential": false }
  ]
}
```

Optional: a short text excerpt of the visible form legend. Cap node list (e.g. 80–120). If more, prefer viewport-visible nodes and note truncation.

### 8.3 Find It for Me

User: “Where do I upload my resume?”

1. Scan + badges on.
2. Model returns **only** JSON:

```json
{ "n": 17, "confidence": "high", "reason": "File input labelled Resume" }
```

3. Schema validate.
4. Highlight element 17; **do not click**.

### 8.4 One-step agent loop

```text
                    ┌──────────── persist session ────────────┐
                    ▼                                         │
 AGENT_START → perceive (extract + scan)                      │
        → safety.preflight(url)                               │
        → model: next_action JSON                             │
        → validate schema + safety.postcheck(action, node)    │
        → AGENT_PROPOSE to panel (reason, dry-run highlight)  │
        → WAIT user (SW may sleep; state is in storage) ──────┘
        → Approve: AGENT_EXECUTE one action
        → Skip: ask model for a different next action
        → Stop: mark session stopped, hide badges
        → if action.type === "done" or steps >= maxSteps → finish
        → else loop
```

Supported actions:

```ts
type AgentAction =
  | { type: "click"; n: number; reason: string }
  | { type: "type"; n: number; value: string; reason: string }
  | { type: "select"; n: number; value: string; reason: string }
  | { type: "scroll"; direction: "up" | "down" | "intoView"; n?: number; reason: string }
  | { type: "done"; reason: string };
```

The model must output exactly one action per turn. Application code ignores extra keys.

### 8.5 Approval UI

Each proposal shows:

- Action type and human sentence (“Type ‘Pranav’ into #3 Full name”).
- Reason (one line).
- Target highlight / badge pulse.
- Buttons: **Approve**, **Skip**, **Stop**.
- If `node.consequential` or verb matches Submit/Pay/Send: second confirm (“This looks like Submit. Continue?”).
- Dry-run: Approve only highlights; execution is skipped and the log records `dry-run`.

### 8.6 Persistence across service-worker sleep

`chrome.storage.session` (preferred) or `local` key `agent.session`:

```ts
type AgentSession = {
  id: string;
  tabId: number;
  urlAtStart: string;
  goal: string;
  maxSteps: number;
  step: number;
  scanGeneration: number;
  status: "idle" | "awaiting_approval" | "executing" | "done" | "stopped" | "blocked";
  pendingAction: AgentAction | null;
  dryRun: boolean;
  log: ActionLogEntry[];
  updatedAt: number;
};
```

On SW wake, any `awaiting_approval` session is re-broadcast as `AGENT_STATE`. Do not auto-execute a pending action.

### 8.7 Action log

Each entry:

```ts
{
  step: number;
  proposed: AgentAction;
  decision: "approved" | "skipped" | "stopped" | "blocked" | "dry-run";
  at: string; // ISO time
}
```

Shown in the panel; stored with the session; not sent to the model except a short digest of last few steps so the model does not repeat skipped actions.

### 8.8 Practice errands

Restrict agent start unless:

- URL matches the provided practice environment, **or**
- User has marked the origin as “I own/control this page” in settings (explicit opt-in).

Practice scenarios to design the executor against:

1. Multi-step internship-style form.
2. Shop search + filters.
3. Collect fields across two pages into a table shown in the panel (read-only aggregation; still one approved action at a time).

---

## 9. Memory and skills (Week 4)

### 9.1 Local profile

`chrome.storage.local.profile`:

```ts
{
  name?: string;
  college?: string;
  skills?: string;
  links?: string;
  preferredLanguage: "en" | "hinglish";
  preferredTone: "neutral" | "polite" | "concise";
}
```

Used as optional context for drafts and as a dictionary for `type` actions **only** when:

- The target node is not sensitive.
- The value comes from profile fields, not from the model inventing secrets.
- The user still approves the `type` action (the value is visible in the proposal).

Profile never syncs and never is committed to git.

### 9.2 One-click skills

A skill is a local prompt recipe:

```ts
type Skill = {
  id: string;
  name: string;
  description: string;
  kind: "summarise" | "chat" | "agent" | "draft";
  prompt: string;
  language?: "en" | "hinglish";
};
```

Run = current page context + skill.prompt + profile snippet if the skill requests it.

Export/import: JSON file via `<input type=file>` / download. Validate schema on import; reject unknown executables or URLs.

---

## 10. Safety architecture (FR-10)

Safety is a pipeline in **code**. Prompts may repeat the rules; they are not the control.

```text
Request
  → classify URL (sensitive vs allowed)
  → classify payload (private document heuristics)
  → if model-bound: redact or refuse
  → if agent-bound: allowlist origin
  → model returns action
  → validate JSON
  → resolve node n
  → field guards (password, otp, autocomplete cc-*)
  → consequential extra confirm
  → execute
```

### 10.1 URL and page blocks

Block agent **and** remote model send for banking/payment/UPI patterns, e.g.:

- Known payment hosts and path tokens (`/upi`, `/payment`, `/checkout` with payment processors — keep a maintainable list plus keyword heuristics).
- `https` pages with password fields in view when the task is agent-login-like.

On block: no capture, no extract upload, no execute. Explain why in the panel.

### 10.2 Field blocks (executor)

Refuse `type` when:

- `input[type=password]`
- `autocomplete` includes `one-time-code`, `cc-number`, `cc-csc`, `cc-exp`
- Accessible name / placeholder / name attribute matches OTP, PIN, CVV, card number, UPI PIN
- `inputmode=numeric` plus OTP-ish naming

These checks run in the content script **immediately before** setting `.value`.

### 10.3 Consequential clicks

If accessible name matches `/submit|pay|send|confirm order|place order|delete account/i` or `type=submit`, require `extraConfirm: true` from the UI even after Approve.

### 10.4 Kill switch

Stop is always visible during an agent session. It:

1. Sets `status: "stopped"`.
2. Ignores any in-flight model response.
3. Removes badges.
4. Refuses further `AGENT_EXECUTE` for that session id.

### 10.5 Secrets in repo

`.gitignore` API keys; README tells users to paste keys in Options. Release ZIP must not contain keys.

### 10.6 What the model is allowed to receive

| Content | Send to Gemini/Groq? |
| --- | --- |
| Public article text on non-blocked URL | Yes |
| Public YouTube URL | Yes (YouTube path only) |
| Visible screenshot on non-blocked URL | Yes (Flash) |
| Profile fields as user-approved fill values | Local only until user starts a draft/fill; still not sent if page is blocked |
| Password/OTP/card values | Never |
| Private email / bank / personal-doc pages | Never |

---

## 11. AI adapters

### 11.1 Router policy

| Task | Default | Escalate | Fallback |
| --- | --- | --- | --- |
| Explain, translate, draft, summarise article, page chat | Gemini Flash-Lite | Flash if quality flag or repair failed | Groq text |
| Screenshot Q&A | Flash | — | None (show error) |
| YouTube public summary | Flash + video input | — | None |
| Find-element JSON | Flash-Lite | Flash on invalid JSON once | Groq JSON if needed |
| Next-action JSON | Flash-Lite | Flash if two invalid JSON or hard page | Groq JSON |

### 11.2 Prompt packing

Shared wrapper:

- Role: browser copilot, not autonomous.
- Output language.
- “No action except via JSON schema for agent tasks.”
- Page context block.
- For agent: “Return a single JSON object, no markdown.”

JSON parsing: strip a single ```json fence if present; then `JSON.parse`; then schema validate.

### 11.3 On-device summarisation (stretch)

If `chrome.ai` / built-in summarizer is available, expose a settings toggle “Offline summary”. Failure falls back to Gemini. Not required for definition of done.

---

## 12. Data stores

| Key | Storage | Contents |
| --- | --- | --- |
| `settings` | local | keys, language, tone, maxSteps, dryRunDefault |
| `profile` | local | user profile fields |
| `skills` | local | skill list |
| `ownedOrigins` | local | origins user marked as owned |
| `agent.session` | session (fallback local) | live agent checkpoint |
| `chat.thread` | session | current tab conversation |
| `logs.recent` | local, capped | last task logs for review |

No remote database. No analytics that upload page text.

---

## 13. Sequence diagrams

### 13.1 Summarise article

```text
Panel          SW              Content           Gemini
  |             |                 |                 |
  | SUMMARISE   |                 |                 |
  |------------>| GET_CONTEXT     |                 |
  |             |---------------->|                 |
  |             |<-- text/title --|                 |
  |             | safety check    |                 |
  |             |---------------------------------->|
  |             |<-- tldr+points -------------------|
  |<-- render --|                 |                 |
```

### 13.2 Approved click

```text
Panel          SW              Content           Gemini
  | AGENT_START |                 |                 |
  |------------>| SCAN            |                 |
  |             |---------------->| badges          |
  |             | next_action JSON|---------------->|
  |< PROPOSE ---|<----------------------------------|
  | APPROVE     |                 |                 |
  |------------>| safety+gen check|                 |
  |             | EXECUTE click   |                 |
  |             |---------------->| element.click() |
  |             | SCAN again      |                 |
  |< PROPOSE2 --| (or DONE)       |                 |
```

---

## 14. UI information architecture

Side panel states:

1. **Empty / no tab** — ask user to open a webpage.
2. **Ready** — composer, language toggle, Summarise, Capture, Skills.
3. **Streaming / loading** — cancel control.
4. **Error** — readable message, retry.
5. **Agent awaiting approval** — proposal card dominates; Stop always visible.
6. **Blocked** — safety explanation, no Approve.

Page overlay states: hidden | badges | highlight-one | dry-run pulse.

---

## 15. Error handling

| Failure | User sees | System does |
| --- | --- | --- |
| Invalid API key | “Check your Gemini key in Settings” | Do not retry loop |
| 429 | “Free-tier busy, retrying…” then fallback | Backoff, then Groq if text |
| Readability empty | “Couldn’t extract an article; try selection or screenshot” | Offer those paths |
| Stale element `n` | “Page changed; planning the next step again” | Rescan, new propose |
| JSON invalid twice | “Sahayak could not plan a safe step” | Stop proposing execute |
| Tab closed | Session stopped | Clear overlay host |

---

## 16. Testing strategy

Because this is an extension, tests are layered:

1. **Unit:** schema validation, URL/field safety, action-map truncation, JSON repair stripping.
2. **Content-script fixtures:** HTML pages in `extension/test-pages/` for scanner numbering.
3. **Manual week gates:** match problem-statement acceptance criteria on real articles, a public YouTube video, and two practice errands.
4. **Safety drills:** open a mocked checkout/password page and confirm block; confirm password inputs cannot be typed even if the model asks.

Do not automate real bank or email accounts.

---

## 17. Packaging and distribution

- GitHub repo with this architecture and the problem statement.
- `README.md`: Load unpacked, get a Gemini key, pin the extension, grant site access as needed.
- GitHub Release: zip of `extension/` only.
- `landing/`: one-page explanation, screenshots, link to release.
- Screenshots: side panel summary, chat, badges + approval card, settings (no keys visible).

---

## 18. Four-week mapping to this architecture

| Week | Theme | Architecture slices to implement |
| --- | --- | --- |
| 1 | Eyes | Manifest, SW, side panel, settings, Gemini text adapter, Readability, YouTube path, language toggle |
| 2 | Brain | Chat context assembler, context menus, capture + crop, router retries/Groq |
| 3 | Hands | Scanner, overlay, schemas, agent loop, session persistence, log, dry-run, practice pages |
| 4 | Memory & ship | Profile, skills import/export, full safety lists, README, zip, GitHub Pages |

Build in vertical slices in the order listed in section 10 of the problem statement. Each slice should leave the extension loadable.

---

## 19. Definition of done (architecture checklist)

The implementation matches this architecture when:

- [ ] Panel, SW, and content scripts communicate only via the typed envelope.
- [ ] Models are called only from the service worker after safety preflight.
- [ ] Agent actions are schema-validated and user-approved; dry-run never mutates.
- [ ] Password/OTP/card typing is impossible in executor code.
- [ ] Blocked URLs never send page bytes to a model.
- [ ] Agent session survives SW sleep without auto-clicking.
- [ ] Profile and skills stay in `chrome.storage.local`.
- [ ] A stranger can install from the GitHub Release ZIP and complete the twelve-step definition of done in the problem statement.

---

## 20. Open implementation choices (defaults)

These are not blocked on product decisions; use the defaults unless a later slice forces a change.

| Topic | Default |
| --- | --- |
| Language | Vanilla JS ES modules in SW; no React required |
| Schema validation | Small local validator (zod if bundled, else hand-written guards) |
| Overlay | Shadow DOM in content script |
| Screenshot crop | Canvas in side panel |
| Agent storage | `chrome.storage.session` with local fallback |
| Practice allowlist | Config array in `safety/urls.js` plus user-owned origins |

When in doubt, prefer less autonomy, less HTML sent to the model, and more user-visible confirmation.
