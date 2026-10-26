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
- [ ] `trait Provider { fn complete(&self, req: ChatRequest) -> Stream<Item = Delta>; fn embed(...) -> Option<...> }` with `OpenAi`, `Anthropic`, `Gemini`, and `OpenAiCompatible { base_url }` (covers Ollama, LM Studio, OpenRouter, Mistral) — validate that the selected local endpoint and model make no external AI requests; configuration alone is not proof of local-only behavior. Start with one remote adapter and one tested local endpoint; additional providers are separate slices.
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
- [x] **Write with AI** (`Cmd+J` in compose): turn the draft text into a full email; "shorter / more formal / friendlier / fix grammar" follow-ups. Later separate opt-in slice: voice matching from the user's last 50 sent emails (sampled, summarised once into a style note stored locally, refreshed monthly). *(Built as Ctrl J, Cmd J on macOS; voice matching not built.)*
- [ ] **Instant Reply**: three short reply suggestions above the reply box for threads that ask a question; `Cmd+1/2/3` inserts.
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
