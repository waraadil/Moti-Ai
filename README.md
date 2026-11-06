# Moti AI

Personal conversation intelligence for your own exported WhatsApp chats.

Moti AI reads a chat export **you** create and keep, learns how each participant communicates,
builds evidence-backed memories about a contact, and (in a later milestone) drafts replies in
your own voice.

**What this is not:** it does not connect to WhatsApp, does not read your messages in any other
way, and never sends anything on your behalf. There is no live automation, by design.

---

## Status of this build

This repository contains the **project foundation**: schema, security model, authenticated
application shell, the WhatsApp export parser, and the import pipeline that stores parsed
messages. It is a real, running application — not a mock-up — but it deliberately does not yet
contain the AI analysis pipeline.

### Working end to end

| Capability | State |
| --- | --- |
| Email/password sign-up and sign-in (Supabase Auth) | Working |
| Per-user data isolation (RLS + composite foreign keys) | Working, tested |
| Responsive application shell (contacts, imports, settings) | Working |
| Add a contact, archive a contact | Working |
| Upload a WhatsApp `.txt` export to private Storage | Working |
| Parse an export into attributable messages | Working, 29 unit tests |
| Persist messages idempotently with duplicate-import protection | Working |
| Dry-run parse preview API (`POST /api/imports/parse`) | Working |
| Health endpoint reporting real configuration state | Working |

### Deliberately not implemented yet

These are marked **Not analysed** in the UI rather than shown with placeholder values:

- Communication profile generation (per-participant style metrics)
- Relationship context extraction
- Memory + evidence extraction
- Reply draft generation
- Sender-mapping UI for exports where no participant is labelled "You"
  (such imports are stored and parked as `needs_review`, not guessed at)

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

Open http://localhost:3000, create an account, add a contact, then import an export.

---

## Environment variables and secret handling

Handled by `src/lib/env`, split into two modules so a browser bundle physically cannot contain
a secret:

| Module | Contains | Importable from |
| --- | --- | --- |
| `src/lib/env/public.ts` | `NEXT_PUBLIC_*` only | Client and server |
| `src/lib/env/server.ts` | service role key and server flags | Server only |
| `src/lib/env/index.ts` | barrel — re-exports **public only** | Anywhere |

The service-role client lives in `src/lib/supabase/admin.ts` and imports `server-only`, so
importing it from a Client Component makes `next build` **fail**. This is verified in CI by
`npm run build`, not just by convention.

`getServerEnv()` also throws if it is ever evaluated in a browser context.

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

`npm run test` runs 68 tests. The schema suite boots a real PostgreSQL engine
([PGlite](https://github.com/electric-sql/pglite)) in memory, applies every migration, and then
asserts the guarantees above actually hold: RLS isolation, cross-user reference rejection,
immutability, cascade behaviour, constraint enforcement and storage policies.

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
    conversations/     WhatsApp export parser (pure, well tested)
    env/               public / server / barrel env accessors
    errors/            typed AppError hierarchy + safe serialisation
    supabase/          browser, server, admin clients + generated-style types
    validation/        Zod schemas for every trust boundary
  server/              data access: auth, contacts, imports, messages, memories
  proxy.ts             session refresh + route protection
supabase/migrations/   schema, RLS, storage policies
tests/                 parser, env, errors, schema
```

**Conventions**

- `src/lib` is pure and framework-agnostic; `src/server` does I/O and always takes a `userId`.
- Server Components by default; `"use client"` only for forms and interactivity.
- Every server action re-derives the user from the session — never from the request body.
- Data the product cannot yet produce is rendered as `Not analysed`, never as zeros.

---

## Roadmap

1. Sender-mapping UI for `needs_review` imports (finish the import loop).
2. Communication profile analysis over stored messages, versioned via `analysis_versions`.
3. Memory + evidence extraction with per-memory citations in the UI.
4. Reply drafting grounded in profile + memories, with accept/edit/discard tracking.
5. Data export and deletion tooling.

## License

GPL-3.0 — see [LICENSE](./LICENSE).
