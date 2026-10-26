# Sprint 10 — AI with your own key

**Status:** in progress · started 2026-10-26

## Delivery scope

**M4 — optional AI, retained in product roadmap.** AI remains wanted, but is not a prerequisite for M1–M3. Start with explicit user-triggered summaries and draft/rewrite, one tested remote provider plus a tested local endpoint. More providers, automatic labels, Ask AI and voice matching are later slices; their acceptance does not block the first AI slice.

Package number is a stable ID, not a delivery week. [PLAN.md](../PLAN.md) defines order and release gates.

## Overview

AI assistance is opt-in, using a local endpoint or the user's chosen remote provider/key. No content
is sent to an AI provider unless the user enables that feature; ordinary mail-provider sync is separate.

## Goal

First slice: user-triggered conversation summaries and draft/rewrite assistance. Off by default, with
explicit per-account/feature consent. Ask AI, automatic labels and voice matching are later slices.
Normal mail remains fully usable without AI credentials, models or network calls.

## Tasks

### Provider layer (`tern-core::ai`)
- [ ] `trait Provider { fn complete(&self, req: ChatRequest) -> Stream<Item = Delta>; fn embed(...) -> Option<...> }` with `OpenAi`, `Anthropic`, `Gemini`, and `OpenAiCompatible { base_url }` (covers Ollama, LM Studio, OpenRouter, Mistral) — validate that the selected local endpoint and model make no external AI requests; configuration alone is not proof of local-only behavior. Start with one remote adapter and one tested local endpoint; additional providers are separate slices. *(2026-10-26: `Model` trait with `Anthropic`, `OpenAi` (Chat Completions) and `Gemini` (`streamGenerateContent`) built and tested on canned streams; `OpenAiCompatible`/local not built, see Decisions. Embeddings not needed yet.)*
- [x] Keys in the keyring; base URL + model in settings; "Test connection" button; rate limit and cost guard (tokens per day, setting). *(Done 2026-10-26: key under `tern-mail`/`ai/anthropic`; Test reads the model's entry, free; a daily token limit, default 200k, UTC days.)*
- [x] Streaming over Tauri channels (`tauri::ipc::Channel`) so text appears as it is generated.
- [x] Prompt templates in `crates/tern-core/src/ai/prompts/*.md`, versioned; results cached in `ai_cache (kind, key_hash, model, text, created)`. *(Versioned by content: the cache key hashes the prompt with the mail, so an edited prompt asks again.)*
- [x] Redaction option: strip email addresses and phone numbers from prompts (regex) before sending; on by default for Summaries.

### Privacy and independence (required for the first AI slice)
- [x] When disabled, perform no AI requests, background classification or model downloads; verify across start/restart, sync, read, compose and search. *(Every AI call goes through `ai::allowed` before any keyring read or request; nothing AI runs at start, in sync, search or compose unless asked. Tested in `ai::tests::nothing_is_asked_while_ai_is_off`.)*
- [x] Consent per account and feature; show what text/attachments will be shared and which provider receives it. Do not send attachments by default.
- [ ] Remote AI privacy disclosures must not claim all mail stays on-device. Review Google's restricted-data/assessment requirements; BYOK and opt-in are not blanket exemptions.
- [x] A rejected key, unreachable provider, cost limit or model failure must never block normal mail operations.
- [x] Keep email-derived prompts untrusted. No automatic send, delete or archive based on model instructions; user confirms mail actions.
- [x] Redaction is best-effort, not anonymization. Clear cache on request and document provider-side retention separately.

### Features (first slice is manual summarize + draft/rewrite; automation deferred)
- [x] **Summarize** (manual first; auto-on-open only as a later explicit feature toggle): one line above the conversation, computed on explicit request. A later auto-on-open toggle may use thread length/word count and new-mail invalidation; `Shift+S`... (see key table) expands to 3–5 bullets. Cached per thread + last message id. *(Built: manual only, Shift S. Auto-on-open not built.)*
- [x] **Write with AI** (`Cmd+J` in compose): turn the draft text into a full email; "shorter / more formal / friendlier / fix grammar" follow-ups. Later separate opt-in slice: voice matching from the user's last 50 sent emails (sampled, summarised once into a style note stored locally, refreshed monthly). *(Built as Ctrl J, Cmd J on macOS. Voice matching built 2026-10-26 on request only: Settings → AI → Learn from my sent mail, per account, editable, never refreshed by itself.)*
- [x] **Instant Reply**: three short reply suggestions above the reply box for threads that ask a question; `Cmd+1/2/3` inserts. *(Built 2026-10-26 on request: `Q` or "Suggest replies" above the reply row; `1`–`3` or a click starts a reply with one, since Ctrl+1–9 switch accounts. Not offered on your own last message.)*
- [ ] **Ask AI** (`Cmd+Shift+K`): a question over mail. Retrieval is local: FTS over the query's keywords (LLM extracts them first) → top 20 messages → answer with citations that open the message. No embeddings in v1.
- [ ] **Auto Labels**: user-defined label + prompt ("job applications", "invoices"); classify new Important-split mail in batches of 20 with one call; result becomes a label and optionally a split. Limited to N per day; never auto-archives in v1.

### UI
- [x] AI settings page: enable, provider, model, features toggles, redaction, daily budget, "Delete AI cache".
- [x] Every AI output has a visible "AI" mark and a regenerate / dismiss action; nothing is sent (mail or reply) without the user pressing send.
- [x] Privacy sheet on first enable: what is sent, to whom, how to turn off. *(Shown each time AI is turned on.)*

## Cut first
Automatic labels, Instant Reply, voice matching, Ask AI and additional provider adapters. Keep manual summaries and draft/rewrite; never cut consent or disabled-mode isolation.

## Acceptance
- With AI disabled and no key, normal mail operations work and no AI requests occur.
- With a chosen remote provider enabled: explicitly summarize a 10-message thread; streaming/caching works, latency is recorded rather than guaranteed for every model/network.
- With Ollama via the compatible provider: same summary, no outbound traffic to anything but `localhost` (verify AI traffic with request logging/capture while controlling background mail sync; a one-time socket snapshot is insufficient).
- Provider failure and disabling AI do not interfere with mail; cached data can be cleared.
- Later automation slice only: Auto Label "invoices" catches 9/10 of a seeded set; test false positives too.

## Decisions

- 2026-10-26, owner: the first slice is **Anthropic only**, with the person's own key. **No local endpoint
  (Ollama) yet**: the owner's machine can't run a useful local model to test it. The provider-layer task, the
  Ollama acceptance check and the other adapters stay open.
- Anthropic over plain HTTPS (ureq, the same rustls and platform verifier as the rest), not an SDK: there is no
  official Rust SDK. One streamed `POST /v1/messages` per ask, `anthropic-version: 2026-10-21`, effort `low`
  (short everyday work), no temperature or thinking settings. Opus and Sonnet ask for Anthropic's server-side
  refusal fallback (`fallbacks: "default"`); Haiku has none. A refusal is shown as an error and its partial text
  dropped.
- Models offered: Claude Opus 5.5 (default), Sonnet 5.5, Haiku 5.5. The person picks; the help line says what
  each costs relative to Opus.
- `ai_cache` gained `account_id` (cascade) so an account's summaries go when it is removed, and `ai_usage` counts
  tokens per UTC day for the limit (schema v25). Write with AI answers are not cached: each ask is a new draft.
- The model gets no tools, so it can only return text. Mail goes inside `<conversation>`/`<replying_to>` tags with
  closing tags in it broken up, and the system prompt says it is material, not instructions. Quoted replies are
  left out of summaries (shorter and less to inject through).
- Consent: AI on (after the privacy sheet), per feature (Summaries, Write with AI) and per account (ticked; all
  ticked on first turn-on, shown in the sheet's wake). The engine checks all three on every call.
- 2026-10-26, owner: add OpenAI and Gemini, voice matching and Instant Reply, **all on request like the rest**:
  nothing learns or suggests by itself. Voice matching is a button per account ("Learn from my sent mail"), not
  the monthly refresh the task described; suggested replies wait for `Q`.
- OpenAI goes through Chat Completions (`max_completion_tokens`, no temperature or reasoning settings, which some
  current models refuse); Gemini through `streamGenerateContent?alt=sse` with `x-goog-api-key`. Their model lineups
  change every few weeks (GPT-6 Sol/Luna/Astra and Gemini 3.8 Flash / 4 Argon as of October 2026), so Settings
  lists what the key can use (`GET /models`), filtered to text chat models, with `gpt-6-sol` and
  `gemini-flash-latest` as where the list starts. Switching provider turns AI off until the privacy sheet is
  agreed again, since someone else then receives the mail. The sheet adds, for Gemini, that Google's free tier may
  use what is sent to improve its products.
- The transcript now marks the reader's own messages `from="you"` (by the account's address), for summaries and
  replies alike. The style note learns from the person's own messages by address (so Gmail's sent mail in All Mail
  counts), without quotes or signatures, at most 50, 2,000 characters each; it is stored in `ai_styles` (schema
  v26) and deleted with the account.
- 2026-10-26, owner: one provider and one model for everything was a flaw (every feature asked Opus). Now any
  providers at once, each with its key, and a model per feature (`AiSettings::uses`, `ai::route`), with each
  provider's small model as the default for summaries and replies. Consent is per provider (`agreed`): turning on
  agrees to those in use; a model from another one asks first, and the engine refuses a provider not agreed to.
  Settings saved before keep working: their one provider counts as agreed. Each request names its provider and
  `providers::Router` sends it there.
- Open for the owner: the Google restricted-data / assessment review for Gmail accounts sending mail to a remote
  provider (privacy task 3) is a policy review, not code. Today Tern ships Gmail on app passwords without a Google
  client, so no Google API scope is involved, but the review should still be done before AI is announced.

## Log

- 2026-10-26: first slice built on `sprint/10-ai`. Engine `tern-core::ai` (settings, consent gate, redaction,
  transcript, cache, budget, Summary/Write) and `ai::anthropic` (streamed Messages API, errors in words, key in
  the keyring), schema v25, Tauri commands streaming over channels, Settings → AI with the privacy sheet, the
  summary line under a conversation's subject (Shift S) and Write with AI in compose (Ctrl J). 13 engine tests with
  a scripted model and canned SSE streams. UI tried in `npm run dev` against the fake mailbox (it streams a made-up
  answer): settings, sheet, summary, write/use. Not yet tried: a real Anthropic key in `npm run tauri dev`
  (owner).
- 2026-10-26: owner tested the first slice in `npm run tauri dev` with a real key: works. Then OpenAI and Gemini
  providers (shared keys/HTTP/error wording in `ai::providers`), suggested replies (Q, 1–3), the writing style per
  account, schema v26. 27 AI engine tests. Tried in `npm run dev` on the fake: provider switch and Gemini sheet,
  Learn style, Q then 1 starts the reply. Not yet tried with real OpenAI or Gemini keys (owner).
- 2026-10-26: redesign from the canvas "Tern AI redesign ideas" (owner's picks): summary as a lede with Due /
  Asked / Decided chips (the prompt asks for those lines), suggested replies as labelled intent cards ("Label |
  reply"), Write with AI as word changes with Keep / Undo (Send waits; shown under the draft, not inside the editor),
  Settings → AI as four steps with the feature table, today's use and what is kept (`ai_stats`), and the style flow
  (a sample written both ways after Learn, then the note as parts to tune). Tried in `npm run dev` on the fake.
- 2026-10-26: Write with AI again (owner picked boards F and G): Space in an empty draft, a back-and-forth of
  versions (Tab keeps, ↑ steps back, Esc drops), written from the whole conversation (`in_reply_to` → the thread's
  transcript) with the earlier turns; new mail also returns To / Cc / Subject, names matched in the local contacts
  (`ai::write` → `Written`, `prompts/new_mail.md`). The word-diff view gave way to versions. 31 AI tests.
