# Moti AI

Personal conversation intelligence for your own exported WhatsApp chats.

Moti AI reads a chat export **you** create and keep, learns how each participant communicates,
builds evidence-backed memories about a contact, and (in a later milestone) drafts replies in
your own voice.

**What this is not:** it does not connect to WhatsApp, does not read your messages in any other
way, and never sends anything on your behalf. There is no live automation, by design.

**Import is two steps, on purpose.** Moti AI reads the export, then shows you every participant and
asks which one is you. Messages are written only after you confirm — and the contact association
can be corrected at that point. Getting this wrong would permanently mislabel every message,
because stored messages are immutable.

---

## Status of this build

This repository contains the schema, security model, authenticated application shell, the
WhatsApp export parser, the import pipeline that stores parsed messages, and the **conversation
intelligence engine** that analyses those messages. It is a real, running application — not a
mock-up. See [Analysis engine](#analysis-engine) for exactly what is and is not implemented.

### Working end to end

| Capability | State |
| --- | --- |
| Email/password sign-up and sign-in (Supabase Auth) | Working |
| Per-user data isolation (RLS + composite foreign keys) | Working, tested |
| Responsive application shell (contacts, imports, settings) | Working |
| Add a contact, archive a contact | Working |
| Upload a WhatsApp `.txt` export to private Storage | Working |
| Parse an export into attributable messages | Working |
| Group conversations rejected rather than mis-analysed | Working |
| Participant confirmation before anything is stored | Working |
| Persist messages idempotently with duplicate-import protection | Working |
| Duplicate detection before upload, with Storage cleanup | Working |
| DMY/MDY date format carried from preview through to storage | Working |
| Dry-run parse preview API (`POST /api/imports/parse`) | Working |
| Health endpoint reporting real configuration state | Working |
| Participant resolution from confirmed sender mappings | Working, tested |
| Communication style analysis, one profile per participant | Working, tested |
| Conversation understanding (topics, plans, questions, open threads, details) | Working, tested |
| Evidence-backed memories with speaker, timestamp and evidence status | Working, tested |
| Versioned analysis runs with supersede-not-overwrite history | Working, tested |
| Duplicate-memory prevention by fingerprint | Working, tested |
| Temporal diff between imports (new info, plans, changes) | Working, tested |
| Reply draft generation with forbidden-phrase rejection | Working, tested |
| Reply drafts persisted and reviewed (accept / edit / discard) | Working, tested |
| Memory correction and archival from the contact page | Working, tested |

### Deliberately not implemented yet

- `.zip` exports (rejected with an explanation: unzip and upload the `.txt`)
- Group chat participant mapping (group exports are rejected outright)
- Sending anything, anywhere: Moti AI has no send path and no WhatsApp automation
- Background/queued analysis: a run happens inside the request that triggers it

---

## Analysis engine

The engine lives in `src/lib/intelligence/` (pure, deterministic services),
`src/lib/ai/` (provider abstraction) and `src/server/analysis/` (orchestration
and persistence). Services never import UI or database code, so each is tested
in isolation.

### Providers

| Provider | When | What it does |
| --- | --- | --- |
| `deterministic` (default) | No API key configured | Applies real extraction rules to your messages. No network calls, no cost, fully offline. |
| `anthropic` | `MOTI_ANALYSIS_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` | Sends the transcript to the Claude Messages API and validates the JSON reply against the same schemas. |

Both providers return the same validated shape, and the provider and model are
recorded on every analysis version. **The hosted provider path has not been
exercised against the live API in this repository** — no key is present in the
build environment, so only the deterministic path has run end to end. Enabling
it requires setting the two variables above; the app refuses to start if the
hosted provider is selected without a key.

### Guarantees, and how they are enforced

- **Attribution is never guessed.** Every message keeps the `direction` its
  import recorded. If the same label appears on both sides, or every message is
  attributed to one person, the run is *refused* with a reason instead of
  producing a blended profile.
- **Direct evidence is separated from interpretation.** Citations carry
  `status: direct | inferred`, and stored evidence rows carry
  `evidence_status: direct | inferred | user_asserted`. Inferences are labelled as
  inferences in the UI.
- **Memories cannot exist without evidence.** A candidate citing no stored
  message is dropped before it reaches the database.
- **Speculation is rejected.** Hypotheticals, negations, questions and hearsay
  are filtered and reported in the run output rather than stored.
- **Runs are idempotent.** The input hash covers message ids, bodies and the
  provider/prompt version. Re-running identical input returns the existing
  version and creates no new rows or memories.
- **Memories are never overwritten.** `fingerprint = sha256(normalised
  statement)` with a partial unique index on active rows; a repeat fact is
  recorded as "already known".
- **Versions are append-only.** A new run inserts version *n+1* and points the
  previous row at its successor via `superseded_by`.
- **Drafts cannot invent commitments.** Model output is rejected if it promises,
  declares feelings, or commits the user to an action, and any memory id it
  cites that was not supplied invalidates the draft.

### Configuration

```bash
MOTI_ANALYSIS_PROVIDER="deterministic"   # or "anthropic"
MOTI_ANALYSIS_MODEL="claude-sonnet-4-5-20250929"
ANTHROPIC_API_KEY=""                      # server-side only, never NEXT_PUBLIC_
```

Enabling `anthropic` sends conversation text to Anthropic. Nothing is sent when
the provider is `deterministic`.

### Running it

Open a contact that has imported messages and press **Analyse conversation**.
The result is reported verbatim: completed (with version and memory counts),
cached (nothing changed), refused (attribution problem), or failed (with the
error). There is no optimistic success state.

---

## Technology

- **Next.js 16** (App Router) with **TypeScript** in strict mode
- **Tailwind CSS v4** (CSS-first `@theme` tokens, light + dark)
- **Supabase** PostgreSQL, Auth and Storage
- **Zod** for validation at every trust boundary
- **Vitest** for unit and database-schema tests (via PGlite, real PostgreSQL in WASM)

---

## Getting started

### 1. Install

```bash
npm install
```

### 2. Create a Supabase project

Create a project at [supabase.com](https://supabase.com), then apply the schema.

**Option A — Supabase CLI (recommended)**

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

**Option B — SQL editor**

Run each file in `supabase/migrations/` **in filename order** in the Supabase SQL editor.

> Requires PostgreSQL 15 or newer (used for composite foreign keys with
> `ON DELETE SET NULL (column)`). Current Supabase projects are on 15+.

### 3. Configure environment

```bash
cp .env.example .env.local
```

Fill in from **Project Settings → Data API / API keys**:

| Variable | Where to find it | Required |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `anon` / publishable key | Yes |
| `NEXT_PUBLIC_APP_URL` | Your app URL (defaults to localhost) | No |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` key | No — background jobs only |
| `MOTI_ENABLE_DB_VERIFY` | `true` to make `/api/health` hit the database | No |

`.env.local` is git-ignored. Never commit real keys.

### 4. Run

```bash
npm run dev
```

Open http://localhost:3000, create an account, add a contact, then import an export. The import
screen lets you pick the date format (Day/Month/Year or Month/Day/Year) — the same setting is used
for the preview, the stored import and any later re-confirmation.

---

## Environment variables and secret handling

Handled by `src/lib/env`, split into two modules so a browser bundle physically cannot contain
a secret:

| Module | Contains | Importable from |
| --- | --- | --- |
| `src/lib/env/public.ts` | `NEXT_PUBLIC_*` only | Client and server |
| `src/lib/env/server.ts` | service role key, `ANTHROPIC_API_KEY`, provider flags | Server only |
| `src/lib/env/index.ts` | barrel — re-exports **public only** | Anywhere |

The service-role client lives in `src/lib/supabase/admin.ts` and imports `server-only`, so
importing it from a Client Component makes `next build` **fail**. This is verified in CI by
`npm run build`, not just by convention.

`getServerEnv()` also throws if it is ever evaluated in a browser context, and refuses to start
when `MOTI_ANALYSIS_PROVIDER=anthropic` is set without `ANTHROPIC_API_KEY`.

---

## Database

Eleven tables, all owned by a user and protected by Row Level Security.

```
profiles ──┬── contacts ──┬── contact_aliases
           │              ├── chat_imports ──── messages
           │              ├── analysis_versions ─┬── communication_profiles
           │              │                      ├── relationship_contexts
           │              │                      ├── memories ─── memory_evidence
           │              │                      └── reply_drafts
           │              └── memories, reply_drafts
```

| Table | Purpose |
| --- | --- |
| `profiles` | App-level user record, mirrors `auth.users` via trigger |
| `contacts` | A person you talk to. Never merged automatically. |
| `contact_aliases` | Alternate names seen in exports, flagged for confirmation |
| `chat_imports` | One uploaded export file + parse progress and warnings |
| `messages` | Parsed messages. **Immutable** once written. |
| `analysis_versions` | Provenance for every model-generated artifact |
| `communication_profiles` | One row per participant (`self` / `contact`) per contact |
| `relationship_contexts` | Current relationship understanding, one per contact |
| `memories` | Atomic, citeable facts. Superseded, never overwritten. |
| `memory_evidence` | Links a memory to the messages that support it |
| `reply_drafts` | Generated suggestions; never auto-sent |

### Security model

Three layers, each of which independently prevents cross-user access:

1. **Row Level Security** on every table: `user_id = auth.uid()`.
2. **Composite foreign keys**: every reference is `(id, user_id)`, so even a
   service-role query cannot attach one user's message to another user's contact.
3. **Semantic triggers**: a message must match its import's contact, and memory
   evidence must cite a message from the same conversation.

Storage buckets (`chat-imports`, `analysis`) are private. Policies require the first path
segment to equal `auth.uid()`, and files are served through short-lived signed URLs.

Messages are append-only: a database trigger rejects `UPDATE`, so the evidence behind an
analysis version can never be silently rewritten.

---

## Commands

```bash
npm run dev            # dev server
npm run build          # production build
npm run start          # run the production build
npm run typecheck      # tsc --noEmit (strict)
npm run lint           # ESLint (next/core-web-vitals + typescript)
npm run test           # Vitest: parser, env, errors, schema
npm run db:verify      # schema tests only (executes migrations in PGlite)
npm run verify         # typecheck + lint + test + build
npm run format         # Prettier
```

---

## Tests

`npm run test` runs 195 tests across 15 files.

| Suite | What it proves |
| --- | --- |
| `tests/schema.test.ts` | Every migration applies to a real PostgreSQL engine (PGlite), and RLS isolation, cross-user reference rejection, immutability, cascades, constraints and storage policies genuinely hold. |
| `tests/parser.test.ts` | The WhatsApp parser handles real export shapes and rejects what it cannot attribute. |
| `tests/import-pipeline.test.ts` | The import flow: rejection of empty/unreadable/group/`.zip` files, duplicate uploads, Storage cleanup, and confirm-then-store. |
| `tests/intelligence/*` | The engine: attribution conflicts, contradictory information, insufficient evidence, duplicate memories, updated imports, forbidden reply phrases, and the temporal diff. |
| `tests/intelligence/pipeline-sql.test.ts` | The **whole pipeline against real PostgreSQL**, through the real schema — proving the constraints, the partial unique fingerprint index and the versioning rules hold outside the fake. |

The fake Supabase client used by the orchestration tests only implements the query surface the code
actually calls, and it now shares one filter path across reads, updates and deletes so a filter can
never be silently ignored.

No test relies on invented credentials or a remote service.

---

## Project structure

```
src/
  app/
    (auth)/            login, signup, auth server actions
    auth/callback/     email-confirmation code exchange
    contacts/          list + detail, contact server actions
    imports/           upload form + history, import server action
    settings/          account and configuration status
    api/
      health/          configuration state, optional live DB check
      imports/parse/   dry-run parse preview, nothing persisted
  components/          ui primitives, shell, forms (client components only where needed)
  lib/
    ai/                provider abstraction: Anthropic client + deterministic engine
    conversations/     WhatsApp export parser (pure, well tested)
    env/               public / server / barrel env accessors
    errors/            typed AppError hierarchy + safe serialisation
    intelligence/      pure analysis services: participants, style, understanding,
                       memory rules, temporal diff, reply validation, Zod schemas
    supabase/          browser, server, admin clients + generated-style types
    validation/        Zod schemas for every trust boundary
  server/
    analysis/          pipeline orchestration, repositories, read helpers
    contacts/ imports/ messages/ memories/ replies/
    auth/
  proxy.ts             session refresh + route protection
supabase/migrations/   schema, RLS, storage policies (0008 = intelligence engine)
tests/                 parser, env, errors, schema, import pipeline,
                       intelligence/ (unit + orchestration + real-PostgreSQL)
```

**Conventions**

- `src/lib` is pure and framework-agnostic; `src/server` does I/O and always takes a `userId`.
- Server Components by default; `"use client"` only for forms and interactivity.
- Every server action re-derives the user from the session — never from the request body.
- Data the product cannot yet produce is rendered as `Not analysed`, never as zeros.
- Pure analysis never touches the database; the pipeline in `src/server/analysis` is the only module
  that both calls the services and writes rows.

---

### Reviewing memory and reply changes

Memory corrections never edit a row in place. "Correct" inserts the corrected
fact and marks the original `status = 'superseded'` with a pointer to its
replacement; "archive" sets `status = 'archived'` and keeps the evidence. The
original wording and its citations are therefore always recoverable, which is why
there is no destructive delete path.

Draft review follows the same principle. Regenerating discards the previous
*open* drafts (they are marked `discarded`, not deleted) and never touches drafts
already accepted or edited. Accepting records `accepted_at`; editing stores the
user's text in `edited_body` alongside Moti's original in `body`, so the
difference between what was suggested and what the human actually sent stays
visible. **No button in this UI sends a message** — accepted text is copied into
WhatsApp by the user.

## Roadmap

1. `.zip` support (extract the inner chat file server-side).
2. Group conversation participant mapping.
3. Queued analysis for large archives (today a run is synchronous).
4. Data export and deletion tooling.
5. Exercising the hosted provider path against the live Anthropic API.

## License

GPL-3.0 — see [LICENSE](./LICENSE).
