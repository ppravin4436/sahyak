/**
 * Sahayak Overlay (overlay.js)
 * Numbered badges drawn on top of interactive elements using a shadow-DOM root,
 * so page CSS cannot restyle them and page clicks are never intercepted.
 * Badges are always pointer-events: none (edge cases 3.1-06, 3.1-07).
 *
 * Exposes window.__SahayakOverlay for content/scanner.js.
 */

(() => {
  const HOST_ID = "sahayak-overlay-root";
  const HOST_ATTR = "data-sahayak-overlay";

  if (window.__SahayakOverlay) return window.__SahayakOverlay;

  /** Entries kept so badges can follow the page while it scrolls (edge case 3.1-08). */
  let entries = [];
  let repositionQueued = false;

  function ensureHost() {
    if (window.__sahayakOverlayHost && window.__sahayakOverlayHost.isConnected) {
      return window.__sahayakOverlayHost;
    }

    // Drop any host left behind by an interrupted previous injection.
    document.querySelectorAll(`[${HOST_ATTR}]`).forEach((el) => el.remove());

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute(HOST_ATTR, "true");
    // Edge case 3.1-07: page overflow/z-index must not hide or shift the overlay.
    host.style.cssText = [
      "position:fixed",
      "inset:0",
      "pointer-events:none",
      "z-index:2147483647",
      "overflow:visible",
      "contain:layout style"
    ].join(";");

    const style = document.createElement("style");
    style.textContent = `
      .layer { position: absolute; inset: 0; pointer-events: none; }
      .badge {
        position: absolute;
        min-width: 18px;
        height: 18px;
        padding: 0 4px;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: center;
        font: 600 11px/1 -apple-system, "Segoe UI", Roboto, sans-serif;
        color: #ffffff;
        background: #0f766e;
        border: 1px solid rgba(255, 255, 255, 0.9);
        border-radius: 9px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
        pointer-events: none;
        font-variant-numeric: tabular-nums;
      }
      .badge.is-sensitive { background: #991b1b; }
      .badge.is-consequential { background: #b45309; }
      .ring {
        position: absolute;
        display: none;
        box-sizing: border-box;
        border: 2px solid #0f766e;
        border-radius: 5px;
        background: rgba(15, 118, 110, 0.14);
        box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.28);
        pointer-events: none;
        animation: sahayak-ring-pulse 1.2s ease-in-out 3;
      }
      @keyframes sahayak-ring-pulse {
        0%, 100% { box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.28); }
        50% { box-shadow: 0 0 0 7px rgba(15, 118, 110, 0.05); }
      }
    `;

    const layer = document.createElement("div");
    layer.className = "layer";

    const ring = document.createElement("div");
    ring.className = "ring";

    const root = host.attachShadow({ mode: "open" });
    root.append(style, layer);
    layer.appendChild(ring);

    document.documentElement.appendChild(host);
    window.__sahayakOverlayHost = host;
    window.__sahayakOverlayLayer = layer;
    window.__sahayakOverlayRing = ring;
    return host;
  }

  /** Positions a badge and, when present, the highlight ring for one entry. */
  function placeEntry(entry) {
    const { el, badge, ring } = entry;
    if (!el || !el.isConnected) {
      badge.style.display = "none";
      if (ring) ring.style.display = "none";
      return;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      badge.style.display = "none";
      if (ring) ring.style.display = "none";
      return;
    }

    // The overlay is position:fixed, so viewport coordinates line up directly.
    badge.style.display = "flex";
    badge.style.left = `${Math.round(rect.left)}px`;
    badge.style.top = `${Math.round(rect.top)}px`;

    if (ring) {
      ring.style.display = "block";
      ring.style.left = `${Math.round(rect.left)}px`;
      ring.style.top = `${Math.round(rect.top)}px`;
      ring.style.width = `${Math.round(rect.width)}px`;
      ring.style.height = `${Math.round(rect.height)}px`;
    }
  }

  function repositionAll() {
    repositionQueued = false;
    entries.forEach(placeEntry);
  }

  function queueReposition() {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(repositionAll);
  }

  /**
   * Draws one badge per node.
   * @param {Array<{ n: number, el: Element, sensitive?: boolean, consequential?: boolean }>} nodes
   */
  function render(nodes) {
    const host = ensureHost();
    const layer = window.__sahayakOverlayLayer;
    const ring = window.__sahayakOverlayRing;
    layer.textContent = "";
    layer.appendChild(ring);
    ring.style.display = "none";
    host.style.display = "block";

    entries = (nodes || []).map((node) => {
      const badge = document.createElement("div");
      badge.className = "badge";
      if (node.sensitive) badge.classList.add("is-sensitive");
      else if (node.consequential) badge.classList.add("is-consequential");
      badge.textContent = String(node.n);
      layer.appendChild(badge);
      return { n: node.n, el: node.el, badge, ring: null };
    });

    repositionAll();

    window.removeEventListener("scroll", queueReposition, true);
    window.removeEventListener("resize", queueReposition);
    window.addEventListener("scroll", queueReposition, true);
    window.addEventListener("resize", queueReposition);
  }

  /**
   * Rings one already-numbered element and brings it into view.
   * Never clicks; the ring is pointer-events: none (edge case 3.2-01).
   * @param {number} n
   * @returns {boolean} true when the element was found and highlighted.
   */
  function highlight(n) {
    const host = ensureHost();
    const ring = window.__sahayakOverlayRing;
    const target = entries.find((entry) => entry.n === Number(n));
    if (!target || !target.el || !target.el.isConnected) return false;

    entries.forEach((entry) => {
      entry.ring = null;
    });
    target.ring = ring;
    host.style.display = "block";

    try {
      target.el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    } catch {
      // Scrolling is a nicety; the ring still shows where the element is.
    }

    // Re-measure after the smooth scroll has had a chance to move the page.
    placeEntry(target);
    setTimeout(repositionAll, 350);

    return true;
  }

  function clear() {
    window.removeEventListener("scroll", queueReposition, true);
    window.removeEventListener("resize", queueReposition);
    entries = [];
    const host = window.__sahayakOverlayHost;
    const ring = window.__sahayakOverlayRing;
    if (ring) ring.style.display = "none";
    if (host) {
      if (window.__sahayakOverlayLayer) window.__sahayakOverlayLayer.textContent = "";
      host.style.display = "none";
    }
  }

  window.__SahayakOverlay = { ensure: ensureHost, render, highlight, clear };
  return window.__SahayakOverlay;
})();
