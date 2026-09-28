const express = require("express");
const cors = require("cors");
const path = require("path");
const { spawn } = require("child_process");
const ytSearch = require("yt-search");

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------------------------------------
// CACHE (search 15 min yaad rahega)
// --------------------------------------------------
const searchCache = new Map();
const CACHE_TTL = 15 * 60 * 1000;
const CACHE_MAX = 300;

function getCache(key) {
  const item = searchCache.get(key);
  if (!item) return null;
  if (Date.now() > item.exp) {
    searchCache.delete(key);
    return null;
  }
  return item.data;
}
function setCache(key, data) {
  if (searchCache.size >= CACHE_MAX) {
    searchCache.delete(searchCache.keys().next().value);
  }
  searchCache.set(key, { data, exp: Date.now() + CACHE_TTL });
}

// --------------------------------------------------
// Middleware
// --------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

// Keep-alive (Render sleep kam kare)
app.get("/health", (req, res) => {
  res.json({ ok: true, cache: searchCache.size, t: Date.now() });
});

// --------------------------------------------------
// FAST SEARCH (retry + cache)
// --------------------------------------------------
async function doSearch(query) {
  const result = await Promise.race([
    ytSearch({ query, pages: 1 }),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("timeout")), 14000)
    ),
  ]);
  return (result.videos || []).slice(0, 12).map((v) => ({
    id: v.videoId,
    title: v.title,
    author: v.author?.name || "Unknown",
    thumbnail:
      v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
    timestamp: v.timestamp || "",
  }));
}

app.get("/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.status(400).json({ error: "query required" });

  const key = query.toLowerCase();
  const hit = getCache(key);
  if (hit) {
    res.setHeader("X-Cache", "HIT");
    return res.json(hit);
  }

  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      console.log(`Search try ${i + 1}:`, query);
      const songs = await doSearch(query);
      setCache(key, songs);
      res.setHeader("X-Cache", "MISS");
      return res.json(songs);
    } catch (e) {
      lastErr = e;
      console.error("Search fail:", e.message);
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  res.status(500).json({ error: "Search failed", detail: lastErr?.message });
});

// --------------------------------------------------
// DOWNLOAD (yt-dlp)
// --------------------------------------------------
app.get("/download", handleDownload);
app.get("/api/download", handleDownload);

function handleDownload(req, res) {
  const id = String(req.query.id || "").trim();
  let title =
    String(req.query.title || "aura-song")
      .replace(/[^\w\s\u0900-\u097F-]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "aura-song";

  if (!id || !/^[a-zA-Z0-9_-]{6,20}$/.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const url = `https://www.youtube.com/watch?v=${id}`;
  console.log("Download:", id, title);

  const bin = process.env.YTDLP_PATH || "yt-dlp";
  const args = [
    "-f", "ba/bestaudio/best",
    "-o", "-",
    "--no-playlist",
    "--no-warnings",
    "--geo-bypass",
    url,
  ];

  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let started = false;
  let err = "";

  child.stderr.on("data", (c) => (err += c.toString()));

  child.stdout.on("data", (chunk) => {
    if (!started) {
      started = true;
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${title}.mp3"`
      );
      res.setHeader("Cache-Control", "no-store");
    }
    res.write(chunk);
  });

  child.on("error", (e) => {
    console.error("spawn error:", e.message);
    if (!res.headersSent) {
      res.status(503).json({
        error: "yt-dlp missing on server. Check Render build command.",
      });
    }
  });

  child.on("close", (code) => {
    if (!started) {
      console.error("yt-dlp exit", code, err.slice(0, 400));
      if (!res.headersSent) {
        // Common on Render: YouTube blocks datacenter IP
        res.status(502).json({
          error:
            "Download blocked on this server (YouTube 403). Works on localhost only.",
          detail: err.slice(0, 200),
        });
      }
    } else {
      res.end();
    }
  });

  req.on("close", () => {
    try {
      child.kill("SIGTERM");
    } catch (_) {}
  });
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Aura Music on", PORT);
});