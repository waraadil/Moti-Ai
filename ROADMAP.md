# Moti AI — Development Roadmap

> Persistent phase-control record. Updated at the end of every phase.
> **One phase at a time. The next phase never begins without explicit approval.**

- **Completed phase:** 1 — Foundation & Chat Import (approved to close; provider groundwork done)
- **Active phase:** 2 — Conversation Intelligence Engine (**not started** — awaiting approval)
- **Last update:** provider-agnostic AI adapter delivered; live-model verification still blocked
- **Branch:** `arena/13e0feb7-moti-ai` · **PR:** #1 (open, unmerged)

---

## Status summary

| Phase | Name | Status | Commit(s) |
| --- | --- | --- | --- |
| 1 | Foundation & Chat Import | **Complete — awaiting approval** | `943bec6`, `47f3de5` |
| 2 | Conversation Intelligence Engine | Not started (engine code exists from earlier work — see note) | — |
| 3 | Personalised Reply Intelligence | Not started | — |
| 4 | Away Mode & Controlled AI Assistance | Not started | — |
| 5 | WhatsApp & Platform Integration | Not started | — |
| 6 | Finalisation, Security & Deployment | Not started | — |

### Important note on existing Phase 2/3-shaped code

Work committed before this roadmap existed (`07ef857`, `abb6b32`, `c117275`) already
contains an intelligence engine, reply drafting and memory correction. That work
was carried out against earlier instructions, **not** against the Phase 2 and
Phase 3 acceptance criteria below.

It will be audited against the real criteria when those phases begin — gaps
reopened rather than assumed complete. Nothing in that code is declared "done"
here.

---

## Phase 1 — Foundation & Chat Import

**Completion goal:** A user can securely sign in, create contacts, import a chat,
confirm participants and store correctly attributed messages.

### Delivered

| Requirement | Status | Evidence |
| --- | --- | --- |
| Authentication and user accounts | Done | Email/password via Supabase Auth; `src/server/auth/session.ts`, `src/app/(auth)/` |
| Database schema and secure data access | Done | Migrations `0001–0007`; RLS on every public table |
| Dashboard and navigation | Done | `/`, `AppShell`, 6 routes |
| Contact management | Done | `/contacts` create + archive (`archive`, never delete) |
| Chat import interface | Done | `/imports`, two-stage review flow |
| WhatsApp `.txt` parsing | Done | Android + iOS formats, 48 parser tests |
| Participant identification and confirmation | Done | Stage 2 requires explicit confirmation; no guessing |
| Import validation and duplicate detection | Done | Checksum dedupe before upload; empty/invalid files rejected before any row is written |
| Secure storage and import history | Done | Private buckets, owner-path policies, `/imports` history |
| Correct timestamps, attribution, preservation | Done | Original `sender_label` and `sent_at` persisted; messages immutable |

### Security properties verified by test

- One user cannot read another's contacts or messages (RLS, 18 schema tests).
- Inserts claiming another user's id are rejected by constraints **even with RLS bypassed**.
- Storage objects are only reachable under the owner's folder path.
- Messages are immutable after insert.
- Group conversations are rejected outright rather than attributed by guesswork.
- Duplicate file imports are blocked by unique index on `(user_id, checksum)`.

### Test results (current HEAD)

```
npm run typecheck   clean
npm run lint        clean
npm test            236 passed / 19 files
npm run db:verify    18 passed (all 7 migrations apply; RLS + constraints enforced)
npm run build       ✓ compiled, 11 routes
```

### Known gaps in Phase 1

- `.zip` exports are rejected with an explanation — no server-side extraction.
- Group chat participant mapping is not implemented (groups rejected by design).
- No live Supabase project has been exercised; verification is against PGlite with
  the real schema, real constraints and real RLS policies.

### Blockers

None. Phase 1 is functionality-complete for its stated scope.

---

## Phase 2 — Conversation Intelligence Engine

**Status:** Not started. Begins only on explicit approval.

### Provider architecture — completed groundwork (commit below)

Phase 2 depends on real model calls, so the provider layer was rebuilt first and
independently of the phase:

| Delivered | Detail |
| --- | --- |
| Provider-agnostic interface | `src/lib/ai/types.ts`; adapters hold no domain logic |
| Anthropic adapter | `src/lib/ai/anthropic.ts` (Messages API) |
| OpenAI-compatible adapter | `src/lib/ai/openai-compatible.ts` — covers OpenAI, Gemini, Groq, Mistral, DeepSeek, Together, OpenRouter, Ollama, LM Studio, and any custom gateway via `MOTI_ANALYSIS_BASE_URL` |
| Deterministic engine | Retained as the default; explicitly labelled *not a language model* in UI, health output and docs |
| Configuration | One `MOTI_ANALYSIS_PROVIDER` variable; one `MOTI_ANALYSIS_API_KEY` for every vendor |
| Validation | Every model response still parsed by Zod before it can reach storage |
| Errors | Typed `ProviderError` with `auth` / `rate_limit` / `timeout` / `network` / `server` / `bad_request` / `bad_response` / `config`, plus user-facing advice |
| Retries & timeouts | Bounded exponential backoff, `Retry-After` respected, per-attempt timeout, no retry on auth/bad-request |
| Secret hygiene | `server-only` boundary; keys never in API responses, diagnostics or logs; provider error bodies scrubbed via `redactSecrets` |
| Connectivity diagnostic | `src/lib/ai/diagnose.ts` + auth-gated `GET /api/ai/diagnose`; separates network / auth / model failure |
| Self-verification | `npm run verify:provider` (`scripts/verify-provider.ts`) |
| Mocked-provider tests | Both adapters and the full pipeline driven through a scripted HTTP layer |

### Known blocker (must be resolved before Phase 2 can meet standard #4)

Engineering standard #4 requires **real AI model calls**, and explicitly forbids
substituting hardcoded responses for working functionality.

Current environment state:

- `api.anthropic.com` and `api.openai.com` are **unreachable** from this sandbox (HTTP 000).
- No `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is present in the environment.
- The existing engine therefore runs on a deterministic rule engine, labelled
  `model_provider = "deterministic"`.

Both adapters are implemented and are exercised end to end **through a mocked HTTP
layer** — request shape, headers, retry classification, response parsing, schema
validation and pipeline integration all run in tests.

What has **not** happened is a call to a real remote model. This environment's
egress filter drops TLS handshakes to every AI host (verified: TCP connects, then
`read 0 bytes` during the handshake) while allowing only package registries and
GitHub. A key alone therefore cannot unblock it.

**To close this, one of these is required:**

1. Run `npm run verify:provider` on a machine with normal internet access, using
   any of the supported providers. It reports reachability, auth and model
   validity separately.
2. Enable egress from this sandbox to one AI endpoint; verification can then be
   run here.
3. Adopt a local runtime (`ollama` / `lmstudio`) — no key, no egress filter issue.

Until one of these is done, standard #4 is **partially** met: the code path is
real and tested, but no live model has produced output in this project.

---

## Phases 3–6

Not started. Scope will be detailed at the start of each phase.

- **Phase 3** — Personalised reply intelligence: style-adapted drafts, multiple
  approaches, rationale, edit/regenerate/copy/dismiss, drafts only.
- **Phase 4** — Away Mode: availability rules, per-contact permissions, human
  approval gates, takeover, return summaries, activity history.
- **Phase 5** — Platform integration: official mechanisms only, no
  reverse-engineered WhatsApp APIs, capability limits stated honestly.
- **Phase 6** — Finalisation: security audit, RLS verification, deletion/export,
  performance, mobile/Android, themes, accessibility, deployment, docs.

---

## Approval log

| Phase | Completion reported | Approved by user | Date |
| --- | --- | --- | --- |
| 1 | Yes | Yes — "Proceed with Option 2" | 2026-11-08 |
| 2 | No — not started | — | — |

Provider groundwork was requested and delivered as a standalone task between
phases, at the user's direction. It does not constitute starting Phase 2.

No phase advances without an explicit "approved" from the user.
