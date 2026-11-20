// Saves messages from the website's contact form into MongoDB.
// The connection string comes from the MONGODB_URI environment variable (set in Vercel), never from this file.
const { MongoClient } = require("mongodb");
const crypto = require("crypto");

let clientPromise;
function getDb() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
  if (!clientPromise) {
    clientPromise = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 }).connect();
  }
  return clientPromise.then(c => c.db());
}

const clean = (v, max) => (typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, max) : "");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  // Hidden field that people never see; bots that fill it in are ignored silently.
  if (clean(body.website, 200)) return res.status(200).json({ ok: true });

  const name = clean(body.name, 100);
  const email = clean(body.email, 200);
  const message = clean(body.message, 3000);
  const lang = body.lang === "zh" ? "zh" : "en";

  if (!name || !message || message.length < 2) return res.status(400).json({ ok: false, error: "missing" });
  if (email && !EMAIL.test(email)) return res.status(400).json({ ok: false, error: "email" });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const ipHash = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);

  try {
    const messages = (await getDb()).collection("messages");
    // At most 5 messages per visitor every 10 minutes, to stop spam.
    const recent = await messages.countDocuments({ ipHash, createdAt: { $gt: new Date(Date.now() - 10 * 60 * 1000) } });
    if (recent >= 5) return res.status(429).json({ ok: false, error: "rate" });

    const doc = {
      name, email, message, lang, ipHash,
      userAgent: clean(req.headers["user-agent"], 300),
      createdAt: new Date(),
      read: false,
    };
    const r = await messages.insertOne(doc);
    return res.status(200).json({ ok: true, id: String(r.insertedId) });
  } catch (e) {
    console.error("contact save failed:", e && e.message);
    return res.status(500).json({ ok: false, error: "server" });
  }
};
