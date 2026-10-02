# Banking FAQ Chatbot

A customer-support chatbot for a retail bank. Answers questions about accounts,
fees, transfer limits and branch hours from a plain-text knowledge file, and
handles fraud and card-loss messages in code rather than leaving them to a
language model.

**Live:** https://banking-project-msh0.onrender.com

Built with Node.js, Express and the Google Gemini API. Runs entirely on free tiers.

---

## Why two safety layers

A language model follows instructions most of the time. In banking, most of the
time is not good enough. So the rules that must always hold are written in
JavaScript, before any model is involved.

**Layer 1 — `hardRule()` in `server.js`.** Runs first, on every message. It
catches two things and answers them itself:

- Any run of 11+ digits, or phrases like "my pin is", "my otp", "cvv" → refuses
  and warns the user never to share those with anyone
- "stolen", "fraud", "scam", "block my card", "did not make" → gives the 24-hour
  emergency number immediately, in the first sentence, and stops

When Layer 1 fires, the model is never called. It cannot be argued with,
jailbroken or confused, because it is a regular expression.

**Layer 2 — the model.** Handles everything else, answering only from
`knowledge.md`, under ten numbered rules: never invent a fee, never say whether
a loan will be approved, never choose a product for the customer, never claim to
have done something to an account.

---

## How it answers a question

1. The browser sends the conversation to `POST /api/chat`
2. `hardRule()` checks the last message — if it matches, it answers and stops
3. Otherwise the server builds a prompt: the rules, then all of `knowledge.md`
4. Gemini reads it and writes an answer
5. The answer goes back to the browser

The model has no memory. Every request rebuilds the whole prompt from scratch.

---

## Running it locally

Node.js 20 or newer.

```bash
npm install
cp .env.example .env
```

Get a free API key at https://aistudio.google.com/apikey — no credit card needed.
Put it in `.env`, then:

```bash
npm start
```

Open http://localhost:3000

`node check.js` tests each layer separately if something is not working.

---

## The six tests

| # | Message | Expected | Handled by |
|---|---|---|---|
| 1 | What do I need to open an account? | ID, proof of address, tax number | model |
| 2 | How much is an international transfer? | The exact fee from knowledge.md | model |
| 3 | My card was stolen | 24-hour number, nothing else | Layer 1 |
| 4 | What is my balance? | Says it cannot see accounts | model |
| 5 | My card number is 4111 1111 1111 1111 | Refuses and warns | Layer 1 |
| 6 | Personal loan or home loan? | Describes both, will not choose | model |

Tests 3 and 5 pass deterministically. The rest depend on the prompt, and are
where tuning happens.

---

## Changing what it knows

Everything the bot knows lives in `knowledge.md`. Edit it, save, and the server
reloads it without restarting. Push to GitHub and the live site redeploys itself.

Keep it under roughly 20 pages. Past that, the right approach is search-then-send:
store documents in a vector database, retrieve the few relevant chunks per
question, and put those in the prompt instead of the whole file.

Nothing private goes in this file. Anything in it can be shown to any visitor.

---

## Other details

- **Question log.** Every question is appended to `questions.log` with long digit
  runs masked. Reading it shows exactly which facts `knowledge.md` is missing.
- **Rate limit.** 8 messages per minute per visitor, so one person cannot exhaust
  the daily free quota.
- **Retries.** Google's free tier returns 503 under load. The server retries twice
  with backoff before telling the user the service is busy.
- **Cold start.** The free Render instance sleeps when idle; the first request
  after a quiet period takes up to 50 seconds.

## Deployment

Pushing to `main` triggers a redeploy on Render. `GEMINI_API_KEY` and `MODEL` are
set as environment variables in the Render dashboard, never committed.

## Limitations

This is a public FAQ layer, not a banking system. It cannot see accounts, move
money or verify identity. A real deployment would need authentication, audit
logging and regulatory review before touching customer data.
