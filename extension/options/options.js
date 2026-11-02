const SETTINGS_KEY = "settings";
const PROFILE_KEY  = "profile";

const statusEl = document.getElementById("status");
const feedbackEl = document.getElementById("feedback");
const inputEl = document.getElementById("gemini-key");
const groqInputEl = document.getElementById("groq-key");
const langEl = document.getElementById("preferred-language");
const translateEl = document.getElementById("translate-target");
const maxStepsEl = document.getElementById("max-steps");
const dryRunEl = document.getElementById("dry-run-default");
const formEl = document.getElementById("key-form");
const clearEl = document.getElementById("clear-key");

// Profile form elements
const profileFeedbackEl  = document.getElementById("profile-feedback");
const profileNameEl      = document.getElementById("profile-name");
const profileCollegeEl   = document.getElementById("profile-college");
const profileSkillsEl    = document.getElementById("profile-skills");
const profileLinksEl     = document.getElementById("profile-links");
const profileToneEl      = document.getElementById("profile-tone");
const profileFormEl      = document.getElementById("profile-form");
const clearProfileEl     = document.getElementById("clear-profile");

function showFeedback(kind, text) {
  feedbackEl.hidden = false;
  feedbackEl.className = `feedback ${kind}`;
  feedbackEl.textContent = text;
}

function hideFeedback() {
  feedbackEl.hidden = true;
  feedbackEl.textContent = "";
}

async function readSettings() {
  const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  return settings && typeof settings === "object" ? settings : {};
}

function hasKey(settings) {
  return typeof settings.geminiApiKey === "string" && settings.geminiApiKey.trim().length > 0;
}

function maskKey(key) {
  if (!key || key.length < 8) return "••••••••••••";
  return key.slice(0, 6) + "••••••••" + key.slice(-4);
}

function renderStatus(settings) {
  const isKeySaved = hasKey(settings);
  const isGroqSaved = typeof settings.groqApiKey === "string" && settings.groqApiKey.trim().length > 0;

  if (isKeySaved) {
    statusEl.innerHTML = `<span style="color:#0f766e;font-weight:600;">✅ Active:</span> Gemini API key is saved (<code>${maskKey(settings.geminiApiKey)}</code>).`;
    inputEl.placeholder = "Key is saved. Paste to replace.";
  } else {
    statusEl.innerHTML = `<span style="color:#b45309;font-weight:600;">⚠️ Not set:</span> No Gemini API key saved.`;
    inputEl.placeholder = "Paste Gemini API key (AIzaSy...)";
  }

  if (isGroqSaved) {
    statusEl.innerHTML += `<br><span style="color:#0f766e;font-weight:600;">✅ Fallback:</span> Groq API key is saved (<code>${maskKey(settings.groqApiKey)}</code>).`;
    groqInputEl.placeholder = "Groq key saved. Paste to replace.";
  } else {
    groqInputEl.placeholder = "Paste Groq API key (gsk_...)";
  }

  if (langEl && settings.preferredLanguage) {
    langEl.value = settings.preferredLanguage;
  }
  if (translateEl && settings.translateTarget) {
    translateEl.value = settings.translateTarget;
  }
  if (maxStepsEl) {
    const saved = parseInt(settings.maxSteps, 10);
    maxStepsEl.value = Number.isFinite(saved) && saved >= 1 && saved <= 50 ? saved : 20;
  }
  if (dryRunEl) {
    dryRunEl.checked = Boolean(settings.dryRunDefault);
  }
}

async function refreshStatus() {
  const settings = await readSettings();
  renderStatus(settings);
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideFeedback();

  const nextKey = inputEl.value.trim();
  const nextGroqKey = groqInputEl.value.trim();
  const nextLang = langEl ? langEl.value : "en";
  const nextTranslate = translateEl ? translateEl.value : "hi";
  const nextMaxSteps = maxStepsEl
    ? Math.min(50, Math.max(1, parseInt(maxStepsEl.value, 10) || 20))
    : 20;
  const nextDryRun = dryRunEl ? dryRunEl.checked : false;

  try {
    const settings = await readSettings();
    const updatedSettings = {
      ...settings,
      preferredLanguage: nextLang,
      translateTarget: nextTranslate,
      maxSteps: nextMaxSteps,
      dryRunDefault: nextDryRun
    };

    let savedKey = false;
    if (nextKey) {
      updatedSettings.geminiApiKey = nextKey;
      savedKey = true;
    }
    if (nextGroqKey) {
      updatedSettings.groqApiKey = nextGroqKey;
      savedKey = true;
    }

    await chrome.storage.local.set({
      [SETTINGS_KEY]: updatedSettings
    });

    inputEl.value = "";
    groqInputEl.value = "";
    await refreshStatus();

    if (savedKey) {
      showFeedback("ok", "✅ Success: API key saved to this device! You can now use Sahayak.");
    } else {
      showFeedback("ok", "Settings updated.");
    }
  } catch {
    showFeedback("err", "Could not save settings. Previous values are unchanged.");
  }
});

clearEl.addEventListener("click", async () => {
  hideFeedback();
  try {
    const settings = await readSettings();
    const next = { ...settings };
    delete next.geminiApiKey;
    delete next.groqApiKey;
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    inputEl.value = "";
    groqInputEl.value = "";
    await refreshStatus();
    showFeedback("ok", "Saved keys cleared.");
  } catch {
    showFeedback("err", "Could not clear keys.");
  }
});

refreshStatus().catch(() => {
  showFeedback("err", "Could not read local settings.");
});

/* ─────────────────────────────────────────────────────────────────────────
   Profile form (Slice 4.1)
   Stored at chrome.storage.local["profile"], separate from "settings".
   ───────────────────────────────────────────────────────────────────────── */

function showProfileFeedback(kind, text) {
  if (!profileFeedbackEl) return;
  profileFeedbackEl.hidden = false;
  profileFeedbackEl.className = `feedback ${kind}`;
  profileFeedbackEl.textContent = text;
}

function hideProfileFeedback() {
  if (!profileFeedbackEl) return;
  profileFeedbackEl.hidden = true;
  profileFeedbackEl.textContent = "";
}

async function readProfile() {
  const stored = await chrome.storage.local.get(PROFILE_KEY);
  const p = stored?.[PROFILE_KEY];
  return p && typeof p === "object" ? p : {};
}

function renderProfile(profile) {
  if (profileNameEl)    profileNameEl.value    = profile.name          || "";
  if (profileCollegeEl) profileCollegeEl.value = profile.college       || "";
  if (profileSkillsEl)  profileSkillsEl.value  = profile.skills        || "";
  if (profileLinksEl)   profileLinksEl.value   = profile.links         || "";
  if (profileToneEl)    profileToneEl.value     = profile.preferredTone || "friendly and polite";
}

async function refreshProfile() {
  const profile = await readProfile();
  renderProfile(profile);
}

if (profileFormEl) {
  profileFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideProfileFeedback();

    const ALLOWED_KEYS = ["name", "college", "skills", "links", "preferredTone"];
    const updates = {
      name:          profileNameEl?.value.trim()    || "",
      college:       profileCollegeEl?.value.trim() || "",
      skills:        profileSkillsEl?.value.trim()  || "",
      links:         profileLinksEl?.value.trim()   || "",
      preferredTone: profileToneEl?.value            || "friendly and polite"
    };

    // Build a clean profile: omit empty strings so empty fields don't clutter storage.
    const current = await readProfile();
    const merged  = { ...current };
    for (const k of ALLOWED_KEYS) {
      if (updates[k]) {
        merged[k] = updates[k];
      } else {
        delete merged[k];
      }
    }

    try {
      await chrome.storage.local.set({ [PROFILE_KEY]: merged });
      await refreshProfile();
      showProfileFeedback("ok", "✅ Profile saved.");
    } catch {
      showProfileFeedback("err", "Could not save profile. Please try again.");
    }
  });
}

if (clearProfileEl) {
  clearProfileEl.addEventListener("click", async () => {
    hideProfileFeedback();
    try {
      await chrome.storage.local.remove(PROFILE_KEY);
      renderProfile({});
      showProfileFeedback("ok", "Profile cleared.");
    } catch {
      showProfileFeedback("err", "Could not clear profile.");
    }
  });
}

refreshProfile().catch(() => {
  showProfileFeedback("err", "Could not read profile.");
});
