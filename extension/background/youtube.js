/**
 * YouTube URL detection, video ID extraction, and timestamp utilities.
 * Handles youtube.com/watch, youtu.be, m.youtube.com, and embed links.
 */

/**
 * Parses a URL to detect if it is a public YouTube video.
 * @param {string} rawUrl
 * @returns {{ isYouTube: boolean, isVideo?: boolean, videoId?: string, canonicalUrl?: string, reason?: string }}
 */
export function parseYouTubeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { isYouTube: false };
  }

  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.replace(/^www\./, "").toLowerCase();

    if (hostname !== "youtube.com" && hostname !== "m.youtube.com" && hostname !== "youtu.be") {
      return { isYouTube: false };
    }

    let videoId = null;

    if (hostname === "youtu.be") {
      // Path format: /VIDEO_ID
      const id = url.pathname.slice(1).split(/[?#&/]/)[0];
      if (id && /^[\w-]{11}$/.test(id)) {
        videoId = id;
      }
    } else if (hostname === "youtube.com" || hostname === "m.youtube.com") {
      if (url.pathname === "/watch") {
        const v = url.searchParams.get("v");
        if (v && /^[\w-]{11}$/.test(v)) {
          videoId = v;
        }
      } else if (url.pathname.startsWith("/embed/")) {
        const id = url.pathname.slice(7).split(/[?#&/]/)[0];
        if (id && /^[\w-]{11}$/.test(id)) {
          videoId = id;
        }
      } else if (url.pathname.startsWith("/v/")) {
        const id = url.pathname.slice(3).split(/[?#&/]/)[0];
        if (id && /^[\w-]{11}$/.test(id)) {
          videoId = id;
        }
      } else if (url.pathname.startsWith("/shorts/")) {
        const id = url.pathname.slice(8).split(/[?#&/]/)[0];
        if (id && /^[\w-]{11}$/.test(id)) {
          videoId = id;
        }
      }
    }

    if (!videoId) {
      return {
        isYouTube: true,
        isVideo: false,
        reason: "This is a YouTube navigation page (channel, search, or playlist). Open a specific video to summarize it."
      };
    }

    return {
      isYouTube: true,
      isVideo: true,
      videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`
    };
  } catch {
    return { isYouTube: false };
  }
}

/**
 * Converts timestamp string (e.g. "01:23", "1:02:30", "45s", "1h2m3s") into integer seconds.
 * @param {string|number} stamp
 * @returns {number|null}
 */
export function parseTimestampToSeconds(stamp) {
  if (typeof stamp === "number") return Math.max(0, Math.floor(stamp));
  if (typeof stamp !== "string") return null;

  const s = stamp.trim().replace(/^[\[\(]+|[\]\)]+$/g, "").toLowerCase();

  // Handle formats like "1h20m30s" or "45s"
  if (/^(\d+h)?(\d+m)?(\d+s)?$/.test(s) && (s.includes("h") || s.includes("m") || s.includes("s"))) {
    let hours = 0;
    let minutes = 0;
    let seconds = 0;
    const hMatch = s.match(/(\d+)h/);
    if (hMatch) hours = parseInt(hMatch[1], 10);
    const mMatch = s.match(/(\d+)m/);
    if (mMatch) minutes = parseInt(mMatch[1], 10);
    const sMatch = s.match(/(\d+)s/);
    if (sMatch) seconds = parseInt(sMatch[1], 10);
    return hours * 3600 + minutes * 60 + seconds;
  }

  // Handle formats like "01:23" or "1:02:30"
  if (s.includes(":")) {
    const parts = s.split(":").map((p) => parseInt(p, 10));
    if (parts.some(isNaN)) return null;
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
  }

  const num = parseInt(s, 10);
  return !isNaN(num) && num >= 0 ? num : null;
}

/**
 * Formats seconds into MM:SS or HH:MM:SS.
 * @param {number} totalSeconds
 * @returns {string}
 */
export function formatSecondsToTime(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  const pad = (n) => String(n).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}
