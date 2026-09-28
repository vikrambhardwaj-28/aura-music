const express = require("express");
const cors = require("cors");
const path = require("path");
const { spawn, execFile } = require("child_process");
const ytSearch = require("yt-search");

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------------------------------------
// Search cache
// --------------------------------------------------
const searchCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

function getCache(key) {
  const item = searchCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    searchCache.delete(key);
    return null;
  }
  return item.data;
}

function setCache(key, data) {
  if (searchCache.size >= CACHE_MAX) {
    const first = searchCache.keys().next().value;
    searchCache.delete(first);
  }
  searchCache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

// --------------------------------------------------
// Middleware
// --------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({ ok: true, engine: "yt-dlp", time: new Date().toISOString() });
});

// --------------------------------------------------
// Search
// --------------------------------------------------
app.get("/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    if (!query) return res.status(400).json({ error: "Search query is required" });

    const cacheKey = query.toLowerCase();
    const cached = getCache(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.json(cached);
    }

    console.log("YouTube Search:", query);

    const result = await Promise.race([
      ytSearch(query),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Search timeout")), 12000)
      ),
    ]);

    const songs = (result.videos || []).slice(0, 12).map((video) => ({
      id: video.videoId,
      title: video.title,
      author: video.author?.name || "Unknown Artist",
      thumbnail:
        video.thumbnail ||
        `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
      timestamp: video.timestamp || "",
    }));

    setCache(cacheKey, songs);
    res.setHeader("X-Cache", "MISS");
    res.json(songs);
  } catch (error) {
    console.error("Search Error:", error.message || error);
    res.status(500).json({ error: "YouTube search failed" });
  }
});

// --------------------------------------------------
// Download via yt-dlp (best audio → stream to client)
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
    return res.status(400).json({ error: "Invalid video id" });
  }

  const url = `https://www.youtube.com/watch?v=${id}`;
  console.log("Download (yt-dlp):", id, title);

  // -f ba = best audio only
  // -o - = write to stdout
  // --no-playlist
  const args = [
    "-f", "ba/bestaudio/best",
    "-o", "-",
    "--no-playlist",
    "--no-warnings",
    "--newline",
    url,
  ];

  const child = spawn("yt-dlp", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let started = false;
  let errBuf = "";

  child.stderr.on("data", (chunk) => {
    errBuf += chunk.toString();
  });

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

  child.on("error", (err) => {
    console.error("yt-dlp spawn error:", err.message);
    if (!res.headersSent) {
      res.status(503).json({
        error:
          "yt-dlp not found. Install: brew install yt-dlp  OR  pip3 install -U yt-dlp",
      });
    } else {
      res.end();
    }
  });

  child.on("close", (code) => {
    if (!started) {
      console.error("yt-dlp failed:", errBuf.slice(0, 500));
      if (!res.headersSent) {
        res.status(500).json({
          error: "Download failed",
          detail: errBuf.slice(0, 300),
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

// --------------------------------------------------
// Home
// --------------------------------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("=================================");
  console.log("       AURA MUSIC SERVER");
  console.log("=================================");
  console.log(`Website:  http://localhost:${PORT}`);
  console.log(`Engine:   yt-dlp`);
  console.log(`Search:   http://localhost:${PORT}/search?q=test`);
  console.log(`Download: http://localhost:${PORT}/download?id=VIDEO_ID&title=song`);
  console.log("=================================");
  console.log("");
});