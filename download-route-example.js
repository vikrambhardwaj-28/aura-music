const ytdl = require("@distube/ytdl-core");

module.exports = async function downloadHandler(req, res) {
  try {
    const id = (req.query.id || "").trim();
    const title = (req.query.title || "aura-song").replace(/[^\w\s-]/g, "").trim() || "aura-song";
    if (!id || !ytdl.validateID(id)) {
      return res.status(400).json({ error: "Invalid video id" });
    }
    const url = `https://www.youtube.com/watch?v=${id}`;
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${title.slice(0, 80)}.mp3"`
    );
    ytdl(url, {
      filter: "audioonly",
      quality: "highestaudio",
    }).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: "Download failed" });
  }
};