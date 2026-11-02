# Sahayak — Your AI Browser Copilot

Sahayak is a Chrome extension that sits in your side panel, reads the current page, and helps you act on it — safely and one step at a time.

It can summarise articles and YouTube videos, chat with the current page, explain or translate selected text, scan interactive elements, and execute browser actions — but **only after you approve each step**.

---

## Table of Contents

1. [Quick install](#quick-install)
2. [Get a Gemini API key](#get-a-gemini-api-key)
3. [Features](#features)
4. [Usage guide](#usage-guide)
5. [Practice pages](#practice-pages)
6. [Owned origins — run the agent on your own site](#owned-origins)
7. [Profile and skills](#profile-and-skills)
8. [Safety rules](#safety-rules)
9. [What Sahayak will never do](#what-sahayak-will-never-do)
10. [Keyboard shortcuts](#keyboard-shortcuts)
11. [Troubleshooting](#troubleshooting)
12. [Contributing](#contributing)

---

## Quick install

> **Requires:** Google Chrome (desktop) 116 or later.

### From the GitHub Release ZIP *(recommended)*

1. Go to the **[Releases](../../releases)** page of this repository.
2. Download the latest `sahayak-v*.zip`.
3. Unzip it. You should have an `extension/` folder.
4. Open Chrome and navigate to `chrome://extensions`.
5. Enable **Developer mode** (toggle in the top-right corner).
6. Click **Load unpacked** and select the `extension/` folder you just unzipped.
7. Pin the Sahayak icon from the Chrome toolbar puzzle-piece menu.

### From source

```
git clone https://github.com/YOUR_USERNAME/sahayak.git
```

Then follow steps 4 – 7 above, pointing **Load unpacked** at the `extension/` folder inside the cloned repo.

---

## Get a Gemini API key

Sahayak uses Google's Gemini API. A free tier is available.

1. Visit [Google AI Studio](https://aistudio.google.com/app/apikey) and sign in with a Google account.
2. Click **Create API key**.
3. Copy the key (it starts with `AIzaSy…`).
4. In Chrome, right-click the Sahayak icon → **Options**, or open the side panel and click **Settings**.
5. Paste the key into the **Gemini API key** field and click **Save settings**.

Your key stays on this device in Chrome local storage. It is never written into the extension source and never committed to git.

**Optional:** If you have a [Groq](https://console.groq.com/) API key, paste it into the **Groq API key** field. Sahayak will fall back to Groq for text tasks when Gemini rate-limits.

---

## Features

| Feature | How to use it |
|---|---|
| **Article summary** | Open the side panel → Summary tab → "Summarise this page" |
| **YouTube summary** | Navigate to a public YouTube video → same button |
| **Explain selection** | Highlight text on any page → Chat tab → "Explain selection" |
| **Page chat** | Type a question in the composer at the bottom of the Chat tab |
| **Translate selection** | Highlight text → right-click → "Translate selection" |
| **Draft a reply** | Highlight text → right-click → "Draft a reply" |
| **Screenshot & ask** | Screenshot tab → "Capture visible area" → crop → type a question |
| **Scan page** | Agent tab → "Scan page" — numbers every button, link, and field |
| **Find it for me** | Agent tab → "Find it for me" — describe what you want in plain words |
| **Run an errand** | Agent tab → type a goal → "Start agent" — approves one step at a time |
| **Skills** | Skills tab — one-click prompt recipes for the current page |
| **Profile** | Profile tab — save name, college, skills, links, preferred tone |
| **English / Hinglish** | Language selector in the header |

---

## Usage guide

### 1 · Summarise an article

Navigate to any public article or blog post. Open the side panel (click the Sahayak toolbar icon), switch to the **Summary** tab, and click **Summarise this page**. Sahayak extracts the article text using Readability, strips navigation and ads, and produces a structured summary:

- **TL;DR** — one-sentence bottom line
- **5 Key Points** — the most important facts
- **What to do next** — actionable takeaways

### 2 · Summarise a YouTube video

Open a public YouTube watch page (e.g. `youtube.com/watch?v=…`). Switch to the **Summary** tab and click **Summarise YouTube video**. Sahayak sends the video URL directly to Gemini's video-understanding API — no caption scraping.

Timestamps in the summary are clickable and jump to the right moment in the video.

### 3 · Chat with the page

Switch to the **Chat** tab and type a question in the composer. Sahayak answers using only the page text — it will say so plainly if the answer is not on the page.

### 4 · Explain, Translate, or Draft from selected text

Select any text on the page and right-click. You will see three Sahayak options:

- **Explain selection** — plain-language explanation
- **Translate selection** — translates into your chosen language (Hindi by default)
- **Draft a reply** — ready-to-send reply in your preferred tone

Results appear in the **Actions** tab of the side panel.

### 5 · Screenshot and ask

Switch to the **Screenshot** tab. Click **Capture visible area**. Drag on the image to crop the relevant region (optional). Type a question and click **Ask about screenshot**. Useful for charts, error dialogs, and forms that are not in the article text.

### 6 · Scan the page and find elements

Switch to the **Agent** tab. Click **Scan page** — numbered green badges appear over every interactive element. Click **Find it for me**, describe what you are looking for, and Sahayak rings the matching element without clicking it.

### 7 · Run the agent

Type a goal in the **Run an errand** box (e.g. `"Fill in my name and email then click Next"`). Click **Start agent**.

Sahayak proposes one action at a time:

- **Approve** — runs exactly that action on the page
- **Skip** — asks the model for a different step
- **Stop** — ends the session immediately

Nothing happens until you approve. The **Dry-run** checkbox makes Approve only highlight the element — no DOM changes — useful for testing.

---

## Practice pages

The agent can run on the two bundled practice pages without any extra setup:

| Page | Description |
|---|---|
| **Internship application form** | Multi-step form with text fields, dropdowns, radio buttons, file upload, and a review step |
| **Mini shop** | Product catalogue with search, category filters, price slider, sort, and a cart / checkout flow |

Open either page from the **Agent tab → Practice pages** section. The badges overlay and agent loop work immediately.

---

## Owned origins

The agent can also run on any website **you own or control**. Open that page in Chrome, switch to the **Agent tab**, scroll to **"I own this page"**, and click **Allow this origin**.

Sahayak stores the origin (`https://yoursite.com`) in Chrome local storage. Banking, payment, and UPI pages are still blocked in code regardless of this setting.

To remove an origin, click the same button again (it will read "Remove this origin") or find it in the owned-origins list and click ✕.

---

## Profile and skills

### Profile

Open the **Profile tab**. Fill in your name, college, skills, portfolio link, and preferred tone. Sahayak uses these details when:

- Drafting replies (tone + name context)
- Chatting with a page (personalised system instruction)
- Suggesting values for form fields during an agent run

Profile data never leaves the device.

### Skills

Open the **Skills tab** to see the four starter skills:

| Skill | Kind | What it does |
|---|---|---|
| Exam notes | Summarise | Condenses the page into revision bullets |
| Explain in Hinglish | Chat | Explains the page in easy Hinglish |
| Reply to this email politely | Draft | Drafts a polite reply to selected text |
| Fill this form from my profile | Chat | Lists which fields match your saved profile |

Click **Run** to run a skill on the current page. Click the pencil icon to edit. Click ✕ to delete.

**Add your own:** fill the form at the bottom of the Skills tab and click **Save skill**.

**Export / Import:** use the Export button to download `sahayak-skills.json`. Import it on another device or browser profile.

---

## Safety rules

Sahayak enforces these rules in code, not just in model prompts.

| Rule | Enforcement |
|---|---|
| Never type into password fields | Executor refuses before any DOM write |
| Never type OTP, PIN, CVV, or card numbers | Executor + scanner flag these fields; agent loop pre-checks |
| Never type `autocomplete=one-time-code` or `cc-number` fields | Executor checks autocomplete attribute |
| Banking / payment / UPI pages are blocked | URL host + path checked before any model call or capture |
| Consequential actions (Submit, Pay, Send) need a second tap | Two-tap Approve flow in the panel |
| Kill switch always visible | Stop button is never hidden during an agent run |
| API keys not in source | Stored in `chrome.storage.local` only; excluded from git |
| Agent restricted to practice pages or declared owned origins | Loop checks origin before starting |
| Private pages never sent to remote models | `canSendToModel()` gates every outbound AI call |

---

## What Sahayak will never do

- Automate logins, passwords, or OTP entry
- Enter card numbers or UPI PINs
- Run autonomously without user approval for each step
- Act on banking or payment pages
- Send the contents of private email, banking, or personal-document pages to an external model
- Work on Chrome for Android or iOS
- Publish to the Chrome Web Store (install from the GitHub Release ZIP)

---

## Keyboard shortcuts

There are no custom keyboard shortcuts. Use the mouse to interact with the side panel. The Enter key submits the chat composer and the agent goal input.

---

## Troubleshooting

**The side panel does not open.**
Click the Sahayak toolbar icon. If no icon is visible, open `chrome://extensions`, find Sahayak, and make sure it is enabled. Then pin it from the toolbar puzzle-piece menu.

**"Set your Gemini API key in Settings" banner.**
Open Settings (the button in the top-right of the side panel) and paste your API key. Make sure the key starts with `AIzaSy`. Click **Save settings**.

**Summaries / explanations fail with a rate-limit error.**
Gemini Flash-Lite has a free-tier quota. Wait 30–60 seconds and try again. Adding a Groq API key in Settings enables an automatic text fallback.

**Badges do not appear after Scan page.**
Some pages block content scripts. Try reloading the page and clicking Scan page again. The extension needs `http://` or `https://` pages — internal `chrome://` pages are not supported.

**The agent says "not a practice page".**
Either open one of the bundled practice pages from the Agent tab, or mark the current page as owned using the "I own this page" button.

**Context-menu actions do not appear.**
Right-click only works when you have text highlighted. Select some text first, then right-click.

---

## Contributing

This project was built as a four-week cohort project. Issues and pull requests are welcome. Please do not commit API keys or any credential values — the `.gitignore` already excludes common patterns.

To package a release ZIP:

```powershell
# From the repo root
Compress-Archive -Path extension\* -DestinationPath sahayak-v1.0.0.zip
```

Upload `sahayak-v1.0.0.zip` as a GitHub Release asset. Users download, unzip, and load the `extension/` folder with Load unpacked.

---

*Sahayak — "helper" in Hindi. You stay in control.*
