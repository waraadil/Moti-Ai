# Moti AI — Development Roadmap

> Persistent phase-control record. Updated at the end of every phase.
> **One phase at a time. The next phase never begins without explicit approval.**

- **Completed phases:** 1, 2, 3, 4, 5, 6 — all six delivered in one run at the user's explicit direction ("complete the phases, make it ready as soon as possible")
- **Active phase:** none. Awaiting the user's review and approval.
- **Last update:** 2026-11-06 — post-review hardening (transactional deletion, profile
  anonymisation, failure-injection tests, cloud verification workflow)
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
| 6 | Finalisation, Security & Deployment | **Complete** (export + deletion + docs; cloud deployment **blocked** — see Live deployment) | see PR |

### Status vocabulary used in this file

These words are used precisely; do not read one as another.

| Term | Means | Does **not** mean |
| --- | --- | --- |
| **Implemented** | Code exists, is wired into the app, and is covered by tests that pass on this commit | Verified against a live third-party service |
| **Verified** | A real external service responded correctly, with evidence recorded here | Merely that the code compiles |
| **Blocked** | An external dependency prevents verification, through no code fault | That something is broken or unfinished in code |
| **Not implemented** | The capability does not exist, by design or by omission (stated which) | A hidden gap |

Every row in the phase tables below is **implemented**. Only the rows marked
*Verified* additionally have external evidence. Nothing is marked *Verified*
without a recorded result.

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
| Data deletion (single conversation) | Done — transactional | One database function, so it is all-or-nothing (migration `0011`) |
| Data deletion (everything) | Done — transactional | Same, plus profile anonymisation |
| Retryable storage cleanup | Done | `data_cleanup_jobs` queue; failures are recorded, not hidden |
| Deletion cannot report false completion | Done | `complete` is decided after storage draining, and tested |
| RLS verified by test | Done | 22 schema tests including four new Away Mode isolation tests |
| No secrets in the client bundle | Verified | `grep` over `.next/static` finds no key names |
| Accessibility | Partly | Labels, `role="alert"`/`status` on feedback, semantic lists. Not audited with a screen reader |
| Performance | Not measured | No profiling done; honesty requires saying so |
| Deployment docs | Done | `README.md` setup section, `.env.example` |
| Theme (dark mode) | **Not done** | Committed theme only; a dark mode was never requested and is not implemented |
| Android/mobile | Working by design | Responsive shell; verified by build and markup, not on a device |

### Deletion: what changed after review

The first version deleted table by table from the application. Review found a
real defect: if the fifth statement failed, the first four were already committed
and the user was told "nothing was changed" — which was false. It also refused
optionally to delete anything when a file could not be removed, which sounds safe
but left the user unable to retry.

The design is now:

1. **All row deletion happens inside one database function** (`delete_contact_data`
   / `delete_all_user_data`). PostgREST cannot run a multi-statement transaction
   from the client, so this had to move into the database. Either every row goes
   or none does. Verified against real PostgreSQL by injecting a failure that
   raises mid-function and asserting every row survived.
2. **Identity comes from `auth.uid()`, not a parameter.** A caller cannot ask the
   database to delete another account's data even if the application layer were
   wrong. This is stricter than the previous client-side filtering.
3. **Storage is queued, not deleted inline.** Objects cannot join a database
   transaction. Paths are captured *before* their rows are removed, then removed
   afterwards from `data_cleanup_jobs`. A failed removal keeps its queue row,
   increments an attempt counter, and stays visible.
4. **Completion is honest.** `complete` is computed *after* draining the queue, so
   a committed row deletion with an outstanding file reports `complete: false`
   and names the file. The earlier draft computed it from a flag taken before any
   storage work — caught by a test, not by inspection.
5. **Retry is a first-class action.** "Retry file cleanup" in Settings re-attempts
   only the queued removals. Repeated deletion is safe: a second `deleteEverything`
   removes nothing and honestly reports complete.

### Profile data: exactly what remains

`delete_all_user_data(true)` **anonymises** the profile row rather than deleting it:

| Field | After deletion |
| --- | --- |
| `email` | set to `NULL` |
| `display_name` | replaced with `"Deleted account"` |
| `timezone` | reset to `UTC` |
| `id` | **remains** — a bare UUID |

The row cannot be dropped while the account exists: `profiles.id` is a foreign key
to `auth.users` and the cascade runs the other way. What physically survives is an
identifier with no name, no email and no timezone attached to it.

The Supabase Auth account itself is **not** deleted. That is a separate action
with a different blast radius, it lives in a schema Supabase owns, and deleting it
from an application migration is unsupported. The UI states this plainly rather
than leaving the user to assume their login is gone.

---

## Test and build results at close of Phase 6

```
vitest        434 passed / 434 (31 files)
db:verify      22 passed / 22  (migrations 0001-0011 apply cleanly)
tsc --noEmit   clean
eslint         0 errors, 0 warnings
next build     clean; /away, /integrations, /api/export registered
```

### Implemented vs externally verified

| Capability | Implemented | Externally verified |
| --- | --- | --- |
| Chat import, analysis, memories, drafts | Yes | Yes — everything except the model call runs locally in tests |
| Deterministic analysis engine | Yes | Yes — exercises real code paths in tests |
| Generative AI providers (Anthropic, OpenAI-compatible) | Yes | **No** — every test uses a mocked HTTP transport. No real model has ever answered |
| Away Mode, approval gates, activity log | Yes | Yes — verified against real PostgreSQL via PGlite |
| Transactional deletion + cleanup queue | Yes | Yes — rollback proven against real PostgreSQL |
| Data export | Yes | Yes — row scoping proven by test |
| WhatsApp official connection | **No** — capability model only | No, and none claimed |

### Known blockers, collected as instructed

| # | Blocker | Impact | Owner |
| --- | --- | --- | --- |
| 1 | Egress from the dev sandbox is SNI-filtered for every AI host | No live model call has been verified here | Environment — not code. **Resolved path:** run the `Verify AI provider` GitHub Actions workflow, which needs no computer and no terminal |
| 2 | No AI API key exists in this environment | Standard #4 remains unmet | **User action, no computer needed:** add `MOTI_ANALYSIS_API_KEY` as a GitHub Actions secret, then run the workflow. The key never enters chat or the repo |
| 3 | No Meta/WhatsApp credentials, and no webhook handler exists | No live platform connection | Deliberate: Phase 5 added the capability model, not a connection |
| 4 | Dark mode not implemented | Cosmetic | Not requested; would need a design decision |
| 5 | Performance never measured | Unknown behaviour on very large exports | Future work |

None of these are hidden failures. The app is functional without resolving any of
them; items 1 and 2 are about *verifying* the AI provider, not about the app
working.

**Items 1 and 2 now have a route that needs no computer:** `.github/workflows/verify-provider.yml`
runs the same self-verification script on a GitHub runner, with the key held in an
encrypted Actions secret. See README → "Verifying from a phone". The blocker
stays open until someone actually runs it and records the result here.

### Outstanding after this review

| Item | Status |
| --- | --- |
| Deletion atomicity, retry and honest reporting | Fixed and proven against real PostgreSQL |
| Profile anonymisation | Implemented; what remains is documented above |
| Failure-injection tests | 29 new tests across fake and real database |
| Cloud verification workflow | Added, not yet executed — needs the user's key |
| Dark mode | Still not implemented (never requested) |
| Performance profiling | Still not measured |

---

## Live deployment (2026-11-06)

A dedicated Supabase project was created for this product. No existing project
was reused, modified, paused or deleted — the two pre-existing projects
(`oislvoybwzlheiiklzet`, `qcukxlhxzheoemgxuhgw`) were left untouched, and no
Vercel project belonging to any other product was read or changed.

### Supabase — provisioned and verified

| Property | Value |
| --- | --- |
| Project name | `moti-ai` |
| Project ref | `nmvsfqersgcuonnxphag` |
| Organisation | `pgomvvsiozhdynzesclw` ("waraadil's Org") |
| Region | `ap-south-1` |
| Engine | PostgreSQL 17.11 |
| Status | `ACTIVE_HEALTHY` (db, auth, rest and storage all healthy) |

The migration history in the cloud project, oldest first. The repository keeps
eleven files (`0001`–`0011`); some were split for transport, so there are
nineteen cloud migrations. Concatenating them in this order reproduces the
eleven repository files exactly.

```
20261111060014  foundation_enums_and_helpers                       (0001)
20261111060024  identity_profiles_and_contacts                     (0002)
20261111060040  conversations_imports_and_messages                 (0003)
20261111060059  analysis_versions_and_communication_profiles       (0004 part 1)
20261111060110  analysis_relationships_memories_and_drafts          (0004 part 2)
20261111060120  tenant_integrity_composite_keys                    (0005 part 1)
20261111060128  tenant_integrity_remaining_fks                     (0005 part 2)
20261111060135  tenant_integrity_semantic_checks                   (0005 part 3)
20261111060145  row_level_security                                 (0006)
20261111060155  storage_buckets_and_object_policies                (0007)
20261111060205  intelligence_engine_support_part1                  (0008 part 1)
20261111060215  intelligence_engine_support_part2                  (0008 part 2)
20261111060221  persist_temporal_diff                              (0009)
20261111060231  away_mode                                         (0010 part 1)
20261111060239  away_mode_events_and_rls                           (0010 part 2)
20261111060249  reliable_deletion_cleanup_queue_and_anonymise      (0011 part 1)
20261111060259  reliable_deletion_contact_scope                    (0011 part 2)
20261111060308  reliable_deletion_account_scope                    (0011 part 3)
20261111060315  reliable_deletion_retry_and_privileges             (0011 part 4)
```

### What was checked against the live database, not a mock

| Check | Result |
| --- | --- |
| Tables created | **18** — all 18 with `relrowsecurity = true` |
| Policies | **61** (42 on application tables from `0006`, plus storage and 0011) |
| Storage buckets | **2** — `chat-imports` (50 MB cap), `analysis` (10 MB cap), both private |
| Deletion functions | **4** — `delete_contact_data`, `delete_all_user_data`, `anonymise_profile`, `record_cleanup_failure`, all `SECURITY DEFINER` |
| `anon` role blocked | **Refused**: `permission denied for table contacts` (42501) |
| Signup profile mirror | **Works** — inserting into `auth.users` created the `profiles` row via the trigger |

Row Level Security was proven by behaviour, not by inspection. Against the live
project, using a real `authenticated` JWT sub claim:

1. Seeded a user, contact, chat import, message, memory and evidence row using
   the `service_role` connection.
2. Called `delete_contact_data(<contact>)` as that user. It returned
   `deleted: {contacts: 1, memories: 1, messages: 1, chat_imports: 1,
   memory_evidence: 1}`, `queued_files: 1`, **`complete: false`** — the file was
   queued rather than silently assumed deleted. Row counts afterwards were
   `0, 0, 0, 0, 0` with `1` cleanup job remaining.
3. Called `anonymise_profile(<a different user's id>)` and it was **rejected**
   with `42501: caller may only anonymise their own profile`. Called it for the
   caller's own id, and the profile became `email = null`,
   `display_name = 'Deleted account'`, `timezone = 'UTC'`.
4. Called `delete_all_user_data(true)` while a cleanup job was still queued and
   it honestly returned **`complete: false`**. After draining the queue it
   returned **`complete: true`**.
5. Removed the test user; the cascade left `profiles = 0`, `cleanup jobs = 0`,
   `auth.users = 0`. **No test data remains in the live project.**

### Vercel — project created, deployment blocked

| Property | Value |
| --- | --- |
| Project name | `moti-ai` |
| Project id | `prj_RRvjKITtg3rL0qmM2Zk8YwjH3U3S` |
| Scope | team `team_X0E2WScqWtoyUai3qMirpTxo` (personal hobby account) |
| Framework | `nextjs` |
| Environment variables | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `MOTI_ANALYSIS_PROVIDER=deterministic` — all present, type `encrypted`, target production/preview/development |

The four variables were confirmed to reach the build: a dependency-free probe
deployment showed all four in its build-time `env` list.

**The production deployment itself has not succeeded.** Two independent reasons,
both external to this repository:

| # | Blocker | Detail |
| --- | --- | --- |
| 1 | No GitHub login connection on the Vercel account | `create_project` with `git_repository` was rejected: *"Failed to link waraadil/Moti-Ai. You need to add a Login Connection to your GitHub account first."* Without that link Vercel cannot read the repository. |
| 2 | Vercel's GitHub API quota is exhausted | Every `create_deployment` with a `gitSource` returns `429 Too Many Requests … GitHub API rate limit exceeded`. This is Vercel's own GitHub access, not this sandbox's: the same sandbox token still had 4,996/5,000 requests remaining. |
| 3 | Direct file upload is impractical here | The upload path does work (a probe deployment built), but the app is 97 files / ≈518 KB of source, which is ≈690 KB of base64, well past the single-call argument limit. Uploading deliberately truncated source would produce a build that fails for the wrong reason. |

No deployment was faked and no partial upload was passed off as a deployment.

**What is missing is one action on the user's side, and it needs no terminal:**
sign in to Vercel → **Account Settings → Login Connections → Connect GitHub**.
Once that link exists, the project is already fully configured (framework,
env vars, Supabase auth redirects) and deploying this branch produces the live
site at `https://moti-ai-qss2.vercel.app`.

Nothing in the repository needs to change for that to work, which is why the
remaining step is a connection rather than a commit.

### Still open

| Item | Status |
| --- | --- |
| Vercel production deployment | **Not deployed** — blocked as described above |
| Supabase site URL / redirect allow-list | **Set** — `site_url` = `https://moti-ai-qss2.vercel.app`; allow-list also covers `https://moti-*-qss2.vercel.app/auth/callback` (preview deployments) and `http://localhost:3000` for local work |
| Live URL smoke test | **Not performed** — there is no live URL yet |
| Live AI model call | **Still unverified** — no key was ever available; the deterministic engine is what is configured |
| WhatsApp credentials and webhook | **Still absent** |

### A working instance was started from the build output

To prove the built artefact runs and is configured against the new project, the
production server (`next start`) was started from the verified `next build`
output with the new project's credentials in `.env.local` (git-ignored).

| Route | Result |
| --- | --- |
| `/` | 200 |
| `/login` | 200 |
| `/signup` | 200 |
| `/integrations` | 200 |
| `/settings` | 307 → `/login?next=%2Fsettings` (correct: unauthenticated) |
| `/api/health` | 503, `supabaseConfigured: true`, `analysisProvider: deterministic` (`isGenerative: false`, `hasApiKey: false`) |

`database` reported `unreachable`, and the cause is the sandbox, not the schema:

```
curl https://nmvsfqersgcuonnxphag.supabase.co/rest/v1/
  Connected to ... (172.64.149.246) port 443
  OpenSSL SSL_connect: SSL_ERROR_SYSCALL
```

This dev sandbox only permits egress to an allow-list of hosts
(`api.github.com` and `registry.npmjs.org` return 200; Supabase, like every AI
provider host, is connection-reset). That is also why the database was verified
through Supabase's management API rather than over PostgREST from here. On
Vercel — where egress is unrestricted — this call is expected to succeed, but it
has **not** been observed succeeding, so it is not claimed as verified.

The client bundle was re-checked after this build: the public project URL is
present (it is `NEXT_PUBLIC_` by design) and the service-role key value appears
**0** times in `.next/static`.

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
| 6 | Yes | — | 2026-11-06 |

Dates above are the user's local date (UTC+05:30). The development sandbox clock
runs ahead of it, so commit timestamps in `git log` may read a day later than the
dates recorded here; the recorded dates are the authoritative ones for this
project's schedule.

**Phases 2–6 were built in a single run** at the user's explicit direction:
*"Complete the phases make it ready as soon as possible."* That instruction
overrode the one-phase-at-a-time gate **for that run only**. The gate is back in
force: nothing further advances without an explicit "approved".

The PR remains open and unmerged. Merging requires approval and has not been
requested.
