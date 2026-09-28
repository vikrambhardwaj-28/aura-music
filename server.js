const express = require("express");
const cors = require("cors");
const path = require("path");
const ytSearch = require("yt-search");

const app = express();

const PORT = 3000;

// --------------------------------------------------
// Middleware
// --------------------------------------------------

app.use(cors());
app.use(express.json());

// --------------------------------------------------
// Serve public folder
// --------------------------------------------------

app.use(express.static(path.join(__dirname, "public")));

// --------------------------------------------------
// YouTube Search API
// --------------------------------------------------

app.get("/search", async (req, res) => {
    try {
        const query = String(req.query.q || "").trim();

        if (!query) {
            return res.status(400).json({
                error: "Search query is required"
            });
        }

        console.log("YouTube Search:", query);

        const result = await ytSearch(query);

        const songs = result.videos
            .slice(0, 12)
            .map(video => ({
                id: video.videoId,

                title: video.title,

                author:
                    video.author?.name ||
                    "Unknown Artist",

                thumbnail:
                    video.thumbnail ||
                    `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,

                timestamp:
                    video.timestamp || ""
            }));

        res.json(songs);

    } catch (error) {

        console.error(
            "YouTube Search Error:",
            error
        );

        res.status(500).json({
            error: "YouTube search failed"
        });
    }
});

// --------------------------------------------------
// MP3 Download API (ytdl)
// --------------------------------------------------

app.get("/download", handleDownload);
app.get("/api/download", handleDownload);

async function handleDownload(req, res) {
    try {
        const id = String(req.query.id || "").trim();
        let title = String(req.query.title || "aura-song")
            .replace(/[^\w\s\u0900-\u097F-]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80) || "aura-song";

        if (!id || !/^[a-zA-Z0-9_-]{6,20}$/.test(id)) {
            return res.status(400).json({ error: "Invalid video id" });
        }

        let ytdl;
        try {
            ytdl = require("@distube/ytdl-core");
        } catch (e) {
            try {
                ytdl = require("ytdl-core");
            } catch (e2) {
                console.error("Install: npm install @distube/ytdl-core");
                return res.status(503).json({
                    error: "Download engine not installed. Run: npm install @distube/ytdl-core"
                });
            }
        }

        if (typeof ytdl.validateID === "function" && !ytdl.validateID(id)) {
            return res.status(400).json({ error: "Invalid video id" });
        }

        const url = `https://www.youtube.com/watch?v=${id}`;
        console.log("Download:", id, title);

        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${title}.mp3"`
        );
        res.setHeader("Cache-Control", "no-store");

        const stream = ytdl(url, {
            filter: "audioonly",
            quality: "highestaudio",
            highWaterMark: 1 << 25
        });

        stream.on("error", (err) => {
            console.error("Download stream error:", err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: "Download failed" });
            } else {
                res.end();
            }
        });

        stream.pipe(res);

    } catch (error) {
        console.error("Download error:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: "Download failed" });
        }
    }
}

// --------------------------------------------------
// Home page
// --------------------------------------------------

app.get("/", (req, res) => {
    res.sendFile(
        path.join(__dirname, "public", "index.html")
    );
});

// --------------------------------------------------
// Start Server
// --------------------------------------------------

app.listen(PORT, () => {

    console.log("");
    console.log("=================================");
    console.log("       AURA MUSIC SERVER");
    console.log("=================================");
    console.log(
        `Website:  http://localhost:${PORT}`
    );
    console.log(
        `Search:   http://localhost:${PORT}/search?q=test`
    );
    console.log(
        `Download: http://localhost:${PORT}/download?id=VIDEO_ID&title=song`
    );
    console.log("=================================");
    console.log("");

});