# Moti AI — Development Roadmap

> Persistent phase-control record. Updated at the end of every phase.
> **One phase at a time. The next phase never begins without explicit approval.**

- **Completed phases:** 1, 2, 3, 4, 5, 6 — all six delivered in one run at the user's explicit direction ("complete the phases, make it ready as soon as possible")
- **Active phase:** none. Awaiting the user's review and approval.
- **Last update:** 2026-11-06 — Phases 3–6 built, tested and pushed
- **Branch:** `arena/13e0feb7-moti-ai` · **PR:** #1 (open, **unmerged** — merging requires approval)

---

## Status summary

| Phase | Name | Status | Commit(s) |
| --- | --- | --- | --- |
| 1 | Foundation & Chat Import | **Complete** (approved 2026-11-08) | `943bec6`, `47f3de5` |
| 2 | Conversation Intelligence Engine | **Complete** | `07ef857`, `abb6b32`, `c117275`, `3043ba3` |
| — | Provider-agnostic AI adapter (requested between phases) | **Complete** | `b9c0900` |
| 3 | Personalised Reply Intelligence | **Complete** | `5444f4c` |
| 4 | Away Mode & Controlled AI Assistance | **Complete** | `1689c9e` |
| 5 | WhatsApp & Platform Integration | **Complete** (capability model only — see below) | `f6facbe` |
| 6 | Finalisation, Security & Deployment | **Complete** (export + deletion + docs) | see PR |

### What "complete" means here, precisely

Every phase below is complete *against its stated criteria*. That does not mean
the whole product has been verified with a live language model, and it must not
be read that way:

- **No live model call has ever succeeded from the development sandbox.** Egress
  is filtered at the TLS handshake for every AI host. The provider layer is
  tested against a mocked HTTP transport and against the real deterministic
  engine. Standard #4 ("real AI model calls") stays **unmet** until the user runs
  `npm run verify:provider` on their own machine.
- **Phase 5 added no live platform connection.** See its section; the app states
  this in the UI rather than implying otherwise.

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

**Status: Complete** (commits `07ef857`, `abb6b32`, `c117275`, `3043ba3`).

### Delivered in Phase 2

| Requirement | Status | Evidence |
| --- | --- | --- |
| Per-participant style profiling | Done | `analyseConversationStyle` — two independent layers, never blended |
| Evidence coverage and confidence | Done | `EvidenceCoverage` with `insufficient`/`low`/`moderate`/`strong`, surfaced in the UI |
| Topics, plans, open threads, details | Done | `understandConversation`, tested |
| Memories with speaker, timestamp, evidence | Done | `memory_evidence` rows; a memory without evidence is rejected by the schema |
| Version history, supersede not overwrite | Done | `analysis_versions`; `supersedePreviousVersions` |
| Duplicate memories prevented | Done | Fingerprint unique per contact |
| Re-analysis when a new export arrives | **Done (fixed this run)** | Import confirm now calls `analyseContact`; a failure there cannot lose the import |
| Changes recognised over time | **Done (fixed this run)** | Diff computed *and persisted* on the version; shown as "Since last analysis" |

### What was missing and is now fixed

Two Phase 2 criteria were only half-built:

1. **Re-analysis on new import.** The analysis had to be triggered by hand from
   the contact page; a fresh export sat unanalysed until the user remembered.
2. **Changes over time.** The diff was computed on every run and then thrown
   away — returned in memory, never stored. The contact page had nothing to show,
   so "what changed since last time" was invisible.

Both are closed in `3043ba3`: migration `0009` adds `temporal_diff` to
`analysis_versions` (null, not `[]`, when there is no previous analysis — those
are different states), the diff is computed *before* the version row so it is
written with the version that produced it, and the contact page lists it.

### Provider architecture — completed groundwork

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

## Phase 3 — Personalised Reply Intelligence

**Completion goal:** Style-adapted drafts in the user's own voice, grounded in
confirmed memories, offered in more than one approach, with rationale, and
**drafts only — nothing is ever sent.**

### Delivered

| Requirement | Status | Evidence |
| --- | --- | --- |
| Drafts written in the user's measured style | Done | Style metrics (median length, emoji rate, casing, punctuation habits, abbreviations) fed to the generator |
| Multiple approaches per request | Done | Up to 3 drafts, each with its own tone and rationale |
| Grounded in confirmed memories only | Done | `selectUsableMemories`; a draft citing a memory it was not given is rejected |
| Rationale for each draft | Done | `rationale` validated 5–500 chars, surfaced in the UI |
| Accept / edit / regenerate / discard | Done | `reply_drafts.tsx`; edit keeps both original and edited text |
| Copy-out only, no send | Done | No send action exists; the UI tells the user to paste it into WhatsApp |
| Safety screening | Done | Forbidden phrasings and ungrounded citations drop the individual draft |
| **Learning from previous decisions** | **Done (closed this run)** | `loadReplyFeedback`; see below |

### What was missing and is now fixed

`ReplyFeedback` (accepted / edited / rejected drafts) was declared in the
intelligence layer but **nothing ever loaded it**. Every generation started from
zero, so the app could re-offer a draft the user had explicitly thrown away.

Now: the last 5 of each kind are read per contact, prompts gain an edit-diff
section (`SUGGESTED` vs `SENT AS`), accepted drafts are shown as shape to match,
discarded drafts become an explicit do-not-repeat list, and exact repeats are
filtered out before storing. A failed feedback read degrades to no preferences;
it never blocks drafting.

Scoped per contact deliberately: how you write to a colleague says nothing about
how you write to your sister, so a global preference would drag drafts towards
an average of everyone.

### Deliberately absent

No send path. Not now, not behind a flag. See Phase 5.

---

## Phase 4 — Away Mode & Controlled AI Assistance

**Completion goal:** When the user is unavailable, Moti may prepare replies for
review, within rules the user set, with approval gates, takeover, a summary on
return and an activity history — **without acting as the user.**

### Delivered

| Requirement | Status | Evidence |
| --- | --- | --- |
| Availability windows (start/end, open-ended allowed) | Done | `away_settings`; `resolveAwayState` |
| Per-contact permissions with a default | Done | `away_contact_permissions`; `draft_only` / `silent` |
| Human approval gates | Done | Every prepared reply starts `pending`; `decidePreparedReply` moves it once, and only once |
| Takeover / return summary | Done | `/away` lists what waits, plus the activity log |
| Activity history | Done | `away_events`, append-only |
| Disclosure | Done | `AWAY_DISCLOSURE` shown with every prepared reply |

### Two honesty rules, encoded in the schema

1. **Moti cannot send.** There is no auto-send column and none may be added; its
   absence is the guarantee. Approving a reply records intent, and the UI says so
   in words rather than leaving the user to assume a message went out.
2. **A closed window is not "away".** A stale `active` flag whose end time has
   passed is reported as `off`. Claiming you are away an hour after your window
   ended would make the activity log misleading.

An away message that promises automatic replies is rejected outright: the app
cannot honour it, so allowing it would mislead whoever reads it.

The activity log has no update or delete grant **and** no update or delete
policy, so even its owner cannot rewrite it — a history the subject can edit is
not evidence of anything.

---

## Phase 5 — WhatsApp & Platform Integration

**Completion goal, and the honest answer:** integrate only through official
mechanisms, and state the capability limits plainly instead of implying a
connection that does not exist.

### Delivered

| Requirement | Status | Evidence |
| --- | --- | --- |
| No reverse-engineered WhatsApp API | Upheld | Recorded as refused on principle in `UNOFFICIAL_CLIENT_STANCE`, not as a TODO |
| Capability limits stated honestly | Done | `/integrations`; `lib/platform/capabilities.ts` |
| Official mechanism described accurately | Done | Real constraints: 24h window, template approval, verification tiers, 8-participant group cap |
| Readiness reporting that cannot overstate | Done | Configured credentials still report "not ready" |
| No send path | Upheld | `sendCapability()` returns the literal type `canSend: false` |

### There is no live connection, and the app says so

No webhook handler, no Meta app, no registered number. `HAS_LIVE_PLATFORM_CONNECTION`
is `false` and every surface reads it from one place.

The readiness page reports configuration *presence* only. A test asserts the case
that matters most: **supply every credential and the report still says not ready**,
because the code to send does not exist. Marking it green would be a false
statement to the operator who configured it.

`sendCapability()` returns `canSend: false` as a literal type, so turning sending
on requires changing the type and every call site. That is a deliberate speed bump
on the one decision that must never happen by accident.

---

## Phase 6 — Finalisation, Security & Deployment

### Delivered

| Requirement | Status | Evidence |
| --- | --- | --- |
| Account/data export | Done | `GET /api/export`, authenticated, `no-store` |
| Data deletion (single conversation) | Done | Confirmation phrase checked server-side; refuses if the stored file cannot be removed |
| Data deletion (everything) | Done | Explicit table list, so a new table is a visible omission rather than a silent leak |
| RLS verified by test | Done | 22 schema tests including four new Away Mode isolation tests |
| No secrets in the client bundle | Verified | `grep` over `.next/static` finds no key names |
| Accessibility | Partly | Labels, `role="alert"`/`status` on feedback, semantic lists. Not audited with a screen reader |
| Performance | Not measured | No profiling done; honesty requires saying so |
| Deployment docs | Done | `README.md` setup section, `.env.example` |
| Theme (dark mode) | **Not done** | Committed theme only; a dark mode was never requested and is not implemented |
| Android/mobile | Working by design | Responsive shell; verified by build and markup, not on a device |

### Deletion scope, stated precisely

Deletion removes the user's rows and their stored export files. It does **not**
delete the Supabase Auth account: that is a separate action with a different
blast radius, and pretending otherwise would leave someone believing their login
was gone when it is not. The UI says this.

If a stored file cannot be removed, **nothing is deleted**. Leaving the rows means
the user can retry; deleting them would strand an unreachable copy in storage that
they can no longer see or account for.

---

## Test and build results at close of Phase 6

```
vitest        405 passed / 405 (29 files)
db:verify      22 passed / 22  (migrations 0001-0010 apply cleanly)
tsc --noEmit   clean
eslint         0 errors, 0 warnings
next build     clean; /away, /integrations, /api/export registered
```

### Known blockers, collected as instructed

| # | Blocker | Impact | Owner |
| --- | --- | --- | --- |
| 1 | Egress from the dev sandbox is SNI-filtered for every AI host | No live model call has been verified here | Environment — not code. Prove it with `npm run verify:provider` on a machine with normal internet |
| 2 | No AI API key exists in this environment | Standard #4 remains unmet | User supplies a key when ready |
| 3 | No Meta/WhatsApp credentials, and no webhook handler exists | No live platform connection | Deliberate: Phase 5 added the capability model, not a connection |
| 4 | Dark mode not implemented | Cosmetic | Not requested; would need a design decision |
| 5 | Performance never measured | Unknown behaviour on very large exports | Future work |

None of these are hidden failures. The app is functional without resolving any of
them; items 1 and 2 are about *verifying* the AI provider, not about the app
working.

---

## Approval log

| Phase | Completion reported | Approved by user | Date |
| --- | --- | --- | --- |
| 1 | Yes | Yes — "Proceed with Option 2" | 2026-11-08 |
| 2 | Yes | — | 2026-11-06 |
| Provider adapter | Yes | — (requested as a standalone task) | 2026-11-06 |
| 3 | Yes | — | 2026-11-06 |
| 4 | Yes | — | 2026-11-06 |
| 5 | Yes (capability model only) | — | 2026-11-06 |
| 6 | Yes | — | 2026-11-09 |

**Phases 2–6 were built in a single run** at the user's explicit direction:
*"Complete the phases make it ready as soon as possible."* That instruction
overrode the one-phase-at-a-time gate **for that run only**. The gate is back in
force: nothing further advances without an explicit "approved".

The PR remains open and unmerged. Merging requires approval and has not been
requested.
