// Diagnostic — run with:  node check.js
// Tests each layer separately and prints exactly what happens.

import fs from "node:fs";
import "dotenv/config";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.MODEL || "llama3.2:3b";

console.log("=========================================");
console.log("  CHATBOT DIAGNOSTIC");
console.log("=========================================\n");

console.log("Settings read from .env:");
console.log("  OLLAMA_URL =", OLLAMA_URL);
console.log("  MODEL      =", MODEL);
console.log("  Node       =", process.version);
console.log("");

// ---- 1. knowledge.md ----
let knowledge = "";
try {
  knowledge = fs.readFileSync("knowledge.md", "utf8");
  console.log("[1] knowledge.md .......... OK,", knowledge.length, "characters");
} catch (e) {
  console.log("[1] knowledge.md .......... FAILED:", e.message);
}

// ---- 2. Can we reach Ollama at all? ----
try {
  const r = await fetch(OLLAMA_URL + "/api/tags");
  const { models = [] } = await r.json();
  console.log("[2] Ollama reachable ...... OK");
  console.log("    Installed models:", models.map(m => m.name).join(", ") || "(none)");
  const found = models.some(m => m.name === MODEL);
  console.log("    Model", MODEL, found ? "is installed" : "is NOT INSTALLED <-- problem");
} catch (e) {
  console.log("[2] Ollama reachable ...... FAILED:", e.message);
  console.log("    Ollama is not running, or the URL is wrong.");
  process.exit(1);
}

// ---- 3. Tiny call, no knowledge file ----
console.log("\n[3] Small test call (no knowledge file)...");
let t = Date.now();
try {
  const r = await fetch(OLLAMA_URL + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [{ role: "user", content: "Say the word ready." }]
    })
  });
  const data = await r.json();
  if (r.ok && data?.message?.content) {
    console.log("    OK in", Math.round((Date.now() - t) / 1000), "s. Reply:", data.message.content.trim().slice(0, 60));
  } else {
    console.log("    FAILED. HTTP", r.status);
    console.log("    Response:", JSON.stringify(data).slice(0, 500));
  }
} catch (e) {
  console.log("    FAILED:", e.message);
}

// ---- 4. The real call, exactly as the server makes it ----
console.log("\n[4] Full call WITH the knowledge file...");
t = Date.now();
try {
  const r = await fetch(OLLAMA_URL + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        { role: "system", content: "Answer only from this:\n" + knowledge },
        { role: "user", content: "What are your opening hours?" }
      ],
      options: { temperature: 0.2, num_ctx: 2048, num_predict: 300 }
    })
  });
  const data = await r.json();
  if (r.ok && data?.message?.content) {
    console.log("    OK in", Math.round((Date.now() - t) / 1000), "s.");
    console.log("    ANSWER:", data.message.content.trim());
  } else {
    console.log("    FAILED. HTTP", r.status);
    console.log("    Response:", JSON.stringify(data).slice(0, 800));
  }
} catch (e) {
  console.log("    FAILED after", Math.round((Date.now() - t) / 1000), "s:", e.message);
  if (e.cause) console.log("    Cause:", e.cause.message || e.cause);
}

console.log("\n=========================================");
console.log("Send this whole output back to Claude.");
console.log("=========================================");
