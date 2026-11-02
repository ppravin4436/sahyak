/**
 * Sahayak Content Reader (reader.js)
 * Runs in the context of the webpage.
 * Extracts article text via Mozilla Readability (with robust fallbacks)
 * and selection context with nearby headings.
 * Never holds API keys or calls external models directly.
 */

(() => {
  const MAX_SELECTION_CHARS = 8000;
  const MAX_ARTICLE_CHARS = 28000; // Architecture token budget cap (~24-32k chars)

  /**
   * Check if an element or its ancestor is a sensitive input (password, OTP, etc.).
   * @param {Node|Element|null} node
   * @returns {boolean}
   */
  function isSensitiveElement(node) {
    if (!node) return false;
    const el = node.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (node) : node.parentElement;
    if (!el) return false;

    if (el instanceof HTMLInputElement) {
      if (el.type === "password") return true;
      const autocomplete = el.getAttribute("autocomplete") || "";
      if (/password|one-time-code|cc-number|cc-csc/i.test(autocomplete)) return true;
      const nameOrId = `${el.name} ${el.id} ${el.placeholder}`.toLowerCase();
      if (/\b(otp|pin|cvv|password)\b/.test(nameOrId)) return true;
    }

    const sensitiveAncestor = el.closest('input[type="password"], [data-sensitive="true"]');
    return Boolean(sensitiveAncestor);
  }

  /**
   * Finds the closest preceding heading element for the given range.
   * @param {Range|null} range
   * @returns {string|null}
   */
  function findSurroundingHeading(range) {
    if (!range) return null;
    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) {
      node = node.parentElement;
    }
    if (!node || !(node instanceof Element)) return null;

    // 1. Check if node itself or any parent is a heading
    let ancestor = node;
    while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
      if (/^H[1-6]$/i.test(ancestor.tagName)) {
        const text = ancestor.textContent?.trim();
        if (text) return text;
      }
      ancestor = ancestor.parentElement;
    }

    // 2. Check previous siblings and their children
    let curr = node;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      let prev = curr.previousElementSibling;
      while (prev) {
        if (/^H[1-6]$/i.test(prev.tagName)) {
          const text = prev.textContent?.trim();
          if (text) return text;
        }
        const innerHeading = prev.querySelector("h1, h2, h3, h4, h5, h6");
        if (innerHeading) {
          const text = innerHeading.textContent?.trim();
          if (text) return text;
        }
        prev = prev.previousElementSibling;
      }
      curr = curr.parentElement;
    }

    // 3. Fallback: find nearest heading preceding in DOM order
    try {
      const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"));
      let closest = null;
      for (const h of headings) {
        const relation = h.compareDocumentPosition(node);
        if (relation & Node.DOCUMENT_POSITION_FOLLOWING) {
          closest = h;
        } else {
          break;
        }
      }
      if (closest) {
        const text = closest.textContent?.trim();
        if (text) return text;
      }
    } catch {
      // Non-fatal fallback
    }

    return null;
  }

  /**
   * Reads current text selection and surrounding context.
   */
  function getSelectionContext() {
    let selectionText = "";
    let isSensitive = false;
    let inaccessibleIframe = false;
    let heading = null;
    let range = null;

    const activeEl = document.activeElement;

    if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) {
      if (isSensitiveElement(activeEl)) {
        isSensitive = true;
      } else {
        const start = activeEl.selectionStart ?? 0;
        const end = activeEl.selectionEnd ?? 0;
        if (end > start) {
          selectionText = activeEl.value.substring(start, end).trim();
        }
      }
    }

    if (!selectionText && activeEl instanceof HTMLIFrameElement) {
      try {
        const iframeDoc = activeEl.contentDocument;
        if (iframeDoc) {
          const iframeSel = iframeDoc.getSelection();
          if (iframeSel && iframeSel.rangeCount > 0) {
            selectionText = iframeSel.toString().trim();
            range = iframeSel.getRangeAt(0);
            if (isSensitiveElement(range.startContainer)) {
              isSensitive = true;
              selectionText = "";
            }
          }
        } else {
          inaccessibleIframe = true;
        }
      } catch {
        inaccessibleIframe = true;
      }
    }

    if (!selectionText && !isSensitive) {
      const winSel = window.getSelection();
      if (winSel && winSel.rangeCount > 0) {
        const rawText = winSel.toString();
        selectionText = rawText.trim();
        range = winSel.getRangeAt(0);

        if (isSensitiveElement(winSel.anchorNode) || isSensitiveElement(winSel.focusNode)) {
          isSensitive = true;
          selectionText = "";
        }
      }
    }

    if (range && !heading) {
      heading = findSurroundingHeading(range);
    }

    let truncated = false;
    if (selectionText.length > MAX_SELECTION_CHARS) {
      selectionText = selectionText.slice(0, MAX_SELECTION_CHARS);
      truncated = true;
    }

    return {
      selection: selectionText,
      heading,
      isSensitive,
      inaccessibleIframe,
      truncated
    };
  }

  /**
   * Extracts readable article content using Mozilla Readability with fallbacks.
   * Runs on the live DOM of the document.
   */
  function extractArticle() {
    // Edge case 1.3-11: PDF opened in Chrome
    const isPdf =
      document.contentType === "application/pdf" ||
      window.location.pathname.toLowerCase().endsWith(".pdf") ||
      Boolean(document.querySelector('embed[type="application/pdf"]'));

    if (isPdf) {
      return {
        extractedText: "",
        charCount: 0,
        isTruncated: false,
        isPdf: true,
        extractionMethod: "pdf",
        title: document.title || "PDF Document",
        byline: null,
        siteName: window.location.hostname
      };
    }

    let extractedText = "";
    let extractionMethod = "none";
    let articleTitle = document.title || "Untitled page";
    let byline = null;
    let siteName = window.location.hostname;
    let excerpt = null;

    // 1. Try Mozilla Readability (clone DOM so original is unmodified)
    const ReadabilityClass =
      typeof Readability === "function"
        ? Readability
        : typeof window.Readability === "function"
        ? window.Readability
        : typeof globalThis.Readability === "function"
        ? globalThis.Readability
        : null;

    if (ReadabilityClass) {
      // Edge case: skip Readability on search engine results pages and similar
      // non-article pages where it will always fail and log a runtime error.
      const isSearchPage =
        /^(www\.)?(google|bing|duckduckgo|yahoo|baidu|yandex)\.[a-z.]+\/search/i.test(
          window.location.hostname + window.location.pathname
        ) ||
        document.querySelector('meta[name="robots"][content*="noindex"]') !== null;

      if (!isSearchPage) {
        try {
          const docClone = document.cloneNode(true);
          const reader = new ReadabilityClass(docClone);
          const article = reader.parse();
          if (article && article.textContent && article.textContent.trim().length > 150) {
            extractedText = article.textContent.trim();
            extractionMethod = "readability";
            if (article.title) articleTitle = article.title;
            byline = article.byline || null;
            if (article.siteName) siteName = article.siteName;
            excerpt = article.excerpt || null;
          }
        } catch (err) {
          // Non-fatal: fall through to semantic HTML fallbacks below.
          console.warn("Sahayak: Readability parsing error, falling back to semantic HTML.", err?.message || err);
        }
      }
    }

    // 2. Fallback to <article> element (Edge case 1.3-01)
    if (!extractedText) {
      const articleEl = document.querySelector("article");
      if (articleEl && articleEl.innerText?.trim().length > 100) {
        extractedText = articleEl.innerText.trim();
        extractionMethod = "article";
      }
    }

    // 3. Fallback to <main> or [role="main"]
    if (!extractedText) {
      const mainEl = document.querySelector("main, [role='main']");
      if (mainEl && mainEl.innerText?.trim().length > 100) {
        extractedText = mainEl.innerText.trim();
        extractionMethod = "main";
      }
    }

    // 4. Fallback to standard content container classes
    if (!extractedText) {
      const contentEl = document.querySelector(".post-content, .article-content, .entry-content, #content, .content");
      if (contentEl && contentEl.innerText?.trim().length > 100) {
        extractedText = contentEl.innerText.trim();
        extractionMethod = "container";
      }
    }

    // Clean excessive blank lines
    extractedText = extractedText.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");

    let isTruncated = false;
    if (extractedText.length > MAX_ARTICLE_CHARS) {
      extractedText = extractedText.slice(0, MAX_ARTICLE_CHARS);
      isTruncated = true;
    }

    return {
      extractedText,
      charCount: extractedText.length,
      isTruncated,
      isPdf: false,
      extractionMethod,
      title: articleTitle,
      byline,
      siteName,
      excerpt
    };
  }

  /**
   * Assembles unified page context for both selection and article summarization.
   */
  function getFullPageContext() {
    const sel = getSelectionContext();
    const art = extractArticle();

    return {
      title: art.title || document.title || "Untitled page",
      url: window.location.href,
      byline: art.byline,
      siteName: art.siteName,
      excerpt: art.excerpt,
      extractedText: art.extractedText,
      charCount: art.charCount,
      isTruncated: art.isTruncated,
      isPdf: art.isPdf,
      extractionMethod: art.extractionMethod,
      selection: sel.selection,
      heading: sel.heading,
      isSensitive: sel.isSensitive,
      inaccessibleIframe: sel.inaccessibleIframe,
      selectionTruncated: sel.truncated
    };
  }

  // Set up message listener if not already initialized
  if (!window.__sahayakReaderLoaded) {
    window.__sahayakReaderLoaded = true;

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message !== "object") return false;

      if (message.type === "GET_PAGE_CONTEXT" || message.type === "GET_SELECTION" || message.type === "EXTRACT_ARTICLE") {
        try {
          const data = getFullPageContext();
          sendResponse({ ok: true, data });
        } catch (err) {
          sendResponse({ ok: false, error: err?.message || "Failed to extract page context" });
        }
        return true;
      }

      return false;
    });
  }

  // Return full context immediately for chrome.scripting.executeScript callers
  return getFullPageContext();
})();
