// Banking chatbot backend — runs on Google's Gemini API (free tier).
//
// Nothing runs on your machine except this small server, so it fits on a
// free host. Your two safety layers are unchanged:
//   Layer 1  hard rules in JavaScript. Cannot be argued with. Runs first.
//   Layer 2  the language model, for everything Layer 1 lets through.

import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.MODEL || "gemini-2.5-flash";
const PORT = process.env.PORT || 3000;
const EMERGENCY_NUMBER = process.env.EMERGENCY_NUMBER || "011 200 2000";
const BASE = "https://generativelanguage.googleapis.com/v1beta";

if (!API_KEY) {
  console.error("Missing GEMINI_API_KEY.");
  console.error("Get a free key at https://aistudio.google.com/apikey and put it in .env");
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------
// The knowledge. Edit knowledge.md and save.
// ---------------------------------------------------------------
const KNOWLEDGE_FILE = path.join(__dirname, "knowledge.md");
let knowledge = "";
function loadKnowledge() {
  try {
    knowledge = fs.readFileSync(KNOWLEDGE_FILE, "utf8");
    console.log(`Loaded knowledge.md (${knowledge.length} characters)`);
  } catch {
    knowledge = "";
    console.warn("No knowledge.md found.");
  }
}
loadKnowledge();
try { fs.watch(KNOWLEDGE_FILE, { persistent: false }, () => setTimeout(loadKnowledge, 200)); } catch {}

// ---------------------------------------------------------------
// LAYER 1 — hard rules. These never reach the model.
// ---------------------------------------------------------------
const LOOKS_LIKE_A_NUMBER = /(?:\d[\s-]?){11,}/;

const URGENT = [
  "stolen", "lost my card", "lost card", "card is lost", "fraud", "fraudulent",
  "scam", "scammed", "hacked", "unauthorised", "unauthorized", "didn't make",
  "did not make", "did not authorise", "someone used my", "money missing",
  "money disappeared", "block my card", "freeze my card", "cancel my card"
];

const SECRETS = ["my pin is", "my password is", "my otp", "the code is", "cvv", "my card number"];

function hardRule(text) {
  const t = String(text).toLowerCase();

  if (LOOKS_LIKE_A_NUMBER.test(text) || SECRETS.some(w => t.includes(w))) {
    return "Please stop — never type a card number, PIN, password or one-time code into a chat, " +
      "including this one. No bank employee will ever ask you for them. " +
      "If you have already shared them with someone, call " + EMERGENCY_NUMBER + " right now. " +
      "It is open 24 hours.";
  }

  if (URGENT.some(w => t.includes(w))) {
    return "Call " + EMERGENCY_NUMBER + " straight away — it is open 24 hours. " +
      "You can also freeze the card yourself in the app under Cards, Freeze. " +
      "Please do not wait for a reply here.";
  }

  return null;
}

// ---------------------------------------------------------------
// LAYER 2 — the instructions sent with every request.
// ---------------------------------------------------------------
function buildSystemPrompt() {
  return [
    "You are the help assistant on a bank's public website.",
    "",
    "RULES:",
    "1. Use ONLY the facts in KNOWLEDGE below. Never invent a fee, rate, limit, date or product.",
    "2. If the question is about a product or service that is NOT named in KNOWLEDGE, do not describe it, do not say whether the bank offers it, and do not guess. Say exactly this: I do not have information about that. Please call " + EMERGENCY_NUMBER + ".",
    "3. Never list products that are not in KNOWLEDGE. If KNOWLEDGE does not mention something, treat it as unknown, not as a yes or a no.",
    "4. Never contradict yourself. Read your answer before giving it.",
    "5. You cannot see any account, balance or transaction. Say so if asked.",
    "6. You cannot move money, freeze a card or change a limit. Never say you have done something.",
    "7. Never say whether a loan or card will be approved.",
    "8. Never tell someone which product to choose. List the options from KNOWLEDGE instead.",
    "9. Answer in 3 sentences or fewer. Plain text only, no * or # symbols.",
    "10. Reply in the language the person used.",
    "",
    "KNOWLEDGE:",
    knowledge
  ].join("\n");
}

// ---------------------------------------------------------------
// The question log.
// ---------------------------------------------------------------
const LOG_FILE = path.join(__dirname, "questions.log");
function logQuestion(text, handledBy) {
  const safe = String(text).replace(/(?:\d[\s-]?){6,}/g, "[number removed]").slice(0, 300);
  fs.appendFile(LOG_FILE, `${new Date().toISOString()}\t${handledBy}\t${safe.replace(/\s+/g, " ")}\n`, () => {});
}

// ---------------------------------------------------------------
// A simple rate limit, so one visitor cannot burn the daily quota.
// ---------------------------------------------------------------
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 500) hits.clear();
  return list.length > 8; // 8 messages per minute per visitor
}

// ---------------------------------------------------------------
// The chat endpoint.
// ---------------------------------------------------------------
app.post("/api/chat", async (req, res) => {
  const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];

  const history = incoming
    .filter(m => m && (m.role === "user" || m.role === "assistant"))
    .filter(m => typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }))
    .slice(-12);

  while (history.length && history[0].role !== "user") history.shift();
  if (!history.length) return res.status(400).json({ error: "No messages." });

  const lastMessage = history[history.length - 1].content;

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = obj => res.write("data: " + JSON.stringify(obj) + "\n\n");

  // --- Layer 1 runs first. If it fires, the model is never called. ---
  const forced = hardRule(lastMessage);
  if (forced) {
    logQuestion(lastMessage, "HARD-RULE");
    send({ text: forced });
    send({ done: true });
    return res.end();
  }

  if (tooMany(req.ip)) {
    send({ error: "rate_limited" });
    return res.end();
  }

  logQuestion(lastMessage, "model");

  // Abort only when the RESPONSE closes early (the visitor left the page).
  // Never req.on("close") — on a POST that fires as soon as the body is read.
  const abort = new AbortController();
  let finished = false;
  res.on("close", () => { if (!finished) abort.abort(); });

  const started = Date.now();

  try {
    const r = await fetch(`${BASE}/models/${MODEL}:generateContent`, {
      method: "POST",
      signal: abort.signal,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": API_KEY
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
        // Gemini calls the assistant "model", not "assistant".
        contents: history.map(m => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }]
        })),
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 400
        }
      })
    });

    const data = await r.json();

    if (!r.ok) {
      const msg = data?.error?.message || "";
      console.error("Gemini returned", r.status, msg);
      if (r.status === 429) send({ error: "rate_limited" });
      else if (r.status === 400 && /API key/i.test(msg)) send({ error: "bad_key" });
      else if (r.status === 404) send({ error: "model_missing" });
      else send({ error: "upstream_error" });
      return res.end();
    }

    const answer = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join("");

    if (!answer) {
      const blocked = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
      console.error("Gemini gave no text. Reason:", blocked || "unknown");
      console.error(JSON.stringify(data).slice(0, 400));
      send({ error: "refused" });
      return res.end();
    }

    console.log(`Answered in ${Math.round((Date.now() - started) / 1000)}s`);
    finished = true;
    send({ text: answer });
    send({ done: true });
    res.end();
  } catch (err) {
    if (err.name === "AbortError") {
      console.log("Request cancelled (visitor left the page).");
      return res.end();
    }
    console.error("Request failed:", err);
    send({ error: "upstream_error" });
    res.end();
  }
});

// A health URL, useful once this is on a host.
app.get("/healthz", (_req, res) => res.json({ ok: true, model: MODEL, knowledge: knowledge.length }));

// ---------------------------------------------------------------
// Startup check: is the key valid, and does the model exist?
// ---------------------------------------------------------------
app.listen(PORT, async () => {
  console.log(`Chatbot running on http://localhost:${PORT}`);
  try {
    const r = await fetch(`${BASE}/models`, { headers: { "x-goog-api-key": API_KEY } });
    const data = await r.json();

    if (!r.ok) {
      console.warn(`Gemini rejected the key (HTTP ${r.status}): ${data?.error?.message || ""}`);
      console.warn("Get a free key at https://aistudio.google.com/apikey");
      return;
    }

    const names = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => m.name.replace("models/", ""));

    if (names.includes(MODEL)) {
      console.log(`Gemini key works. Using model: ${MODEL}`);
    } else {
      console.warn(`"${MODEL}" is not available on this key.`);
      const flash = names.filter(n => n.includes("flash")).slice(0, 6);
      console.warn("Free Flash models you can use:", flash.join(", ") || names.slice(0, 6).join(", "));
      console.warn("Put one of those in .env as MODEL=");
    }
  } catch (e) {
    console.warn("Could not reach Gemini:", e.message);
  }
});
