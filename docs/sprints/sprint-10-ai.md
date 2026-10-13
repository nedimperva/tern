# Sprint 10 — AI with your own key

**Status:** todo

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
- [ ] Keys in the keyring; base URL + model in settings; "Test connection" button; rate limit and cost guard (tokens per day, setting).
- [ ] Streaming over Tauri channels (`tauri::ipc::Channel`) so text appears as it is generated.
- [ ] Prompt templates in `crates/tern-core/src/ai/prompts/*.md`, versioned; results cached in `ai_cache (kind, key_hash, model, text, created)`.
- [ ] Redaction option: strip email addresses and phone numbers from prompts (regex) before sending; on by default for Summaries.

### Privacy and independence (required for the first AI slice)
- [ ] When disabled, perform no AI requests, background classification or model downloads; verify across start/restart, sync, read, compose and search.
- [ ] Consent per account and feature; show what text/attachments will be shared and which provider receives it. Do not send attachments by default.
- [ ] Remote AI privacy disclosures must not claim all mail stays on-device. Review Google's restricted-data/assessment requirements; BYOK and opt-in are not blanket exemptions.
- [ ] A rejected key, unreachable provider, cost limit or model failure must never block normal mail operations.
- [ ] Keep email-derived prompts untrusted. No automatic send, delete or archive based on model instructions; user confirms mail actions.
- [ ] Redaction is best-effort, not anonymization. Clear cache on request and document provider-side retention separately.

### Features (first slice is manual summarize + draft/rewrite; automation deferred)
- [ ] **Summarize** (manual first; auto-on-open only as a later explicit feature toggle): one line above the conversation, computed on explicit request. A later auto-on-open toggle may use thread length/word count and new-mail invalidation; `Shift+S`... (see key table) expands to 3–5 bullets. Cached per thread + last message id.
- [ ] **Write with AI** (`Cmd+J` in compose): turn the draft text into a full email; "shorter / more formal / friendlier / fix grammar" follow-ups. Later separate opt-in slice: voice matching from the user's last 50 sent emails (sampled, summarised once into a style note stored locally, refreshed monthly).
- [ ] **Instant Reply**: three short reply suggestions above the reply box for threads that ask a question; `Cmd+1/2/3` inserts.
- [ ] **Ask AI** (`Cmd+Shift+K`): a question over mail. Retrieval is local: FTS over the query's keywords (LLM extracts them first) → top 20 messages → answer with citations that open the message. No embeddings in v1.
- [ ] **Auto Labels**: user-defined label + prompt ("job applications", "invoices"); classify new Important-split mail in batches of 20 with one call; result becomes a label and optionally a split. Limited to N per day; never auto-archives in v1.

### UI
- [ ] AI settings page: enable, provider, model, features toggles, redaction, daily budget, "Delete AI cache".
- [ ] Every AI output has a visible "AI" mark and a regenerate / dismiss action; nothing is sent (mail or reply) without the user pressing send.
- [ ] Privacy sheet on first enable: what is sent, to whom, how to turn off.

## Cut first
Automatic labels, Instant Reply, voice matching, Ask AI and additional provider adapters. Keep manual summaries and draft/rewrite; never cut consent or disabled-mode isolation.

## Acceptance
- With AI disabled and no key, normal mail operations work and no AI requests occur.
- With a chosen remote provider enabled: explicitly summarize a 10-message thread; streaming/caching works, latency is recorded rather than guaranteed for every model/network.
- With Ollama via the compatible provider: same summary, no outbound traffic to anything but `localhost` (verify AI traffic with request logging/capture while controlling background mail sync; a one-time socket snapshot is insufficient).
- Provider failure and disabling AI do not interfere with mail; cached data can be cleared.
- Later automation slice only: Auto Label "invoices" catches 9/10 of a seeded set; test false positives too.

## Decisions

_None yet._

## Log

_No sessions yet._
