/**
 * YouTube captions / transcript → timed lyrics lines
 * Usage in server.js:
 *   const lyricsHandler = require("./lyricsHandler");
 *   app.get("/lyrics", lyricsHandler);
 *
 * Install once:
 *   npm i youtube-transcript
 */
const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function normalizeSegments(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const lines = [];
  for (const item of raw) {
    if (!item) continue;
    // youtube-transcript: { text, duration, offset } offset in ms
    // some forks: { text, start, dur } start in seconds
    let time = 0;
    if (typeof item.offset === "number") time = item.offset / 1000;
    else if (typeof item.start === "number") time = item.start;
    else if (typeof item.time === "number") time = item.time;

    let text = String(item.text || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      // remove [संगीत], [music], [applause] style tags (any script)
      .replace(/\[[^\]]{0,40}\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    // skip leftover pure noise markers
    if (/^(music|applause|laughter|singing|instrumental)$/i.test(text)) continue;
    lines.push({ time: Math.max(0, time), text });
  }
  // merge tiny consecutive fragments into cleaner lines
  if (lines.length < 2) return lines;
  const merged = [];
  let buf = { time: lines[0].time, text: lines[0].text };
  for (let i = 1; i < lines.length; i++) {
    const cur = lines[i];
    const gap = cur.time - buf.time;
    const short = buf.text.length < 42 && cur.text.length < 42;
    if (short && gap < 2.8 && (buf.text + " " + cur.text).length < 90) {
      buf.text = (buf.text + " " + cur.text).replace(/\s+/g, " ").trim();
    } else {
      merged.push(buf);
      buf = { time: cur.time, text: cur.text };
    }
  }
  merged.push(buf);
  return merged;
}

async function fetchWithPackage(videoId) {
  let fetchTranscript;
  try {
    // ESM/CJS interop
    const mod = require("youtube-transcript");
    fetchTranscript = mod.fetchTranscript || (mod.YoutubeTranscript && mod.YoutubeTranscript.fetchTranscript);
    if (!fetchTranscript && mod.default) {
      fetchTranscript = mod.default.fetchTranscript || mod.default;
    }
  } catch (e) {
    return null;
  }
  if (typeof fetchTranscript !== "function") return null;

  const attempts = [
    { lang: "hi" },
    { lang: "en" },
    { lang: "pa" },
    {}, // default track
  ];

  for (const opts of attempts) {
    try {
      const raw = Object.keys(opts).length
        ? await fetchTranscript(videoId, opts)
        : await fetchTranscript(videoId);
      const lines = normalizeSegments(raw);
      if (lines.length) return lines;
    } catch (e) {
      // try next language
    }
  }
  return null;
}

/**
 * Zero-dependency fallback: parse caption tracks from watch page (best-effort).
 */
async function fetchWithTimedtext(videoId) {
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const html = await fetch(watchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "hi-IN,hi;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      signal: AbortSignal.timeout(12000),
    }).then((r) => r.text());

    let player = null;
    const m1 = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
    if (m1) {
      try {
        player = JSON.parse(m1[1]);
      } catch (_) {}
    }
    if (!player) {
      const m2 = html.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
      if (m2) {
        try {
          player = JSON.parse(m2[1]);
        } catch (_) {}
      }
    }
    const tracks =
      player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!Array.isArray(tracks) || !tracks.length) return null;

    const prefer = ["hi", "en", "pa", "en-IN", "en-GB"];
    tracks.sort((a, b) => {
      const la = (a.languageCode || "").toLowerCase();
      const lb = (b.languageCode || "").toLowerCase();
      const ia = prefer.indexOf(la);
      const ib = prefer.indexOf(lb);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

    for (const track of tracks.slice(0, 4)) {
      let base = track.baseUrl;
      if (!base) continue;
      // request json3 for easier parse
      const url = base.includes("fmt=")
        ? base
        : base + (base.includes("?") ? "&" : "?") + "fmt=json3";
      try {
        const body = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          signal: AbortSignal.timeout(10000),
        }).then((r) => (r.ok ? r.text() : ""));
        if (!body) continue;

        // json3
        if (body.trim().startsWith("{")) {
          const json = JSON.parse(body);
          const events = json.events || [];
          const raw = [];
          for (const ev of events) {
            if (!ev.segs) continue;
            const text = ev.segs.map((s) => s.utf8 || "").join("");
            const t = (ev.tStartMs || 0) / 1000;
            raw.push({ start: t, text });
          }
          const lines = normalizeSegments(raw);
          if (lines.length) return lines;
        }

        // XML timedtext
        const chunks = [];
        const re = /<text[^>]*start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/gi;
        let m;
        while ((m = re.exec(body)) !== null) {
          const text = m[2]
            .replace(/<[^>]+>/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, " ")
            .trim();
          if (text) chunks.push({ start: parseFloat(m[1]), text });
        }
        const lines = normalizeSegments(chunks);
        if (lines.length) return lines;
      } catch (_) {}
    }
    return null;
  } catch (_) {
    return null;
  }
}

module.exports = async function lyricsHandler(req, res) {
  try {
    const id = String(req.query.id || "")
      .trim()
      .replace(/^https?:\/\/(www\.)?youtube\.com\/watch\?v=/i, "")
      .replace(/^https?:\/\/youtu\.be\//i, "")
      .slice(0, 11);

    if (!VIDEO_ID_RE.test(id)) {
      return res.status(400).json({ error: "Invalid video id" });
    }

    let lines = await fetchWithPackage(id);
    let source = "youtube-transcript";
    if (!lines || !lines.length) {
      lines = await fetchWithTimedtext(id);
      source = "youtube-timedtext";
    }

    if (!lines || !lines.length) {
      return res.status(404).json({ error: "No captions for this video" });
    }

    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.json({
      id,
      source,
      lines,
    });
  } catch (e) {
    console.error("lyricsHandler", e && e.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Captions failed" });
    }
  }
};
