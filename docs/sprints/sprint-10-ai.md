# Sprint 10 — AI with your own key

**Week 11.** Superhuman AI features, opt-in, with the user's own provider key. Nothing leaves the machine
unless the user turned a feature on and chose a provider.

## Goal

A one-line summary above each conversation; "Write with AI" from bullet points in your voice; "Ask AI" across
local mail; auto-labels that feed the split inbox. Off by default; a clear privacy sheet at enable time.

## Tasks

### Provider layer (`tern-core::ai`)
- [ ] `trait Provider { fn complete(&self, req: ChatRequest) -> Stream<Item = Delta>; fn embed(...) -> Option<...> }` with `OpenAi`, `Anthropic`, `Gemini`, and `OpenAiCompatible { base_url }` (covers Ollama, LM Studio, OpenRouter, Mistral) — the last one gives "local-only" for free.
- [ ] Keys in the keyring; base URL + model in settings; "Test connection" button; rate limit and cost guard (tokens per day, setting).
- [ ] Streaming over Tauri channels (`tauri::ipc::Channel`) so text appears as it is generated.
- [ ] Prompt templates in `crates/tern-core/src/ai/prompts/*.md`, versioned; results cached in `ai_cache (kind, key_hash, model, text, created)`.
- [ ] Redaction option: strip email addresses and phone numbers from prompts (regex) before sending; on by default for Summaries.

### Features
- [ ] **Auto Summarize**: one line above the conversation, computed on open for threads ≥ 2 messages or > 800 words, updated when new mail arrives; `Shift+S`... (see key table) expands to 3–5 bullets. Cached per thread + last message id.
- [ ] **Write with AI** (`Cmd+J` in compose): turn the draft text into a full email; "shorter / more formal / friendlier / fix grammar" follow-ups; voice matching from the user's last 50 sent emails (sampled, summarised once into a style note stored locally, refreshed monthly).
- [ ] **Instant Reply**: three short reply suggestions above the reply box for threads that ask a question; `Cmd+1/2/3` inserts.
- [ ] **Ask AI** (`Cmd+Shift+K`): a question over mail. Retrieval is local: FTS over the query's keywords (LLM extracts them first) → top 20 messages → answer with citations that open the message. No embeddings in v1.
- [ ] **Auto Labels**: user-defined label + prompt ("job applications", "invoices"); classify new Important-split mail in batches of 20 with one call; result becomes a label and optionally a split. Limited to N per day; never auto-archives in v1.

### UI
- [ ] AI settings page: enable, provider, model, features toggles, redaction, daily budget, "Delete AI cache".
- [ ] Every AI output has a visible "AI" mark and a regenerate / dismiss action; nothing is sent (mail or reply) without the user pressing send.
- [ ] Privacy sheet on first enable: what is sent, to whom, how to turn off.

## Cut first
Instant Reply, voice matching, Ask AI (keep Summaries, Write with AI, Auto Labels).

## Acceptance
- With an OpenAI key: open a 10-message thread → a summary appears in under 3 s and is cached on reopen.
- With Ollama via the compatible provider: same summary, no outbound traffic to anything but `localhost` (verify with `ss -tnp`).
- Auto Label "invoices" catches 9/10 of a seeded set.
