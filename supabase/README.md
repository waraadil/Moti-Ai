# Supabase setup

## Apply the schema

**CLI (recommended)**

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

**Or** run the files below in the Supabase SQL editor, in this exact order.

| File | What it does |
| --- | --- |
| `0001_extensions_and_types.sql` | `pgcrypto`, `pg_trgm`, enums, `set_updated_at()`, `confidence_score` domain |
| `0002_identity.sql` | `profiles` (+ `auth.users` mirror trigger), `contacts`, `contact_aliases` |
| `0003_conversations.sql` | `chat_imports`, `messages` (+ immutability trigger) |
| `0004_analysis.sql` | `analysis_versions`, `communication_profiles`, `relationship_contexts`, `memories`, `memory_evidence`, `reply_drafts` |
| `0005_tenant_integrity.sql` | Composite `(id, user_id)` foreign keys + semantic consistency triggers |
| `0006_row_level_security.sql` | RLS policies for every table, grants for `authenticated` only |
| `0007_storage.sql` | Private `chat-imports` and `analysis` buckets + object policies |

`0005` requires PostgreSQL 15+ (`ON DELETE SET NULL (column)` on composite key).

## Verify locally without a project

```bash
npm run db:verify
```

This applies every migration to an in-memory PostgreSQL (PGlite) and asserts
tenant isolation, cascades and constraints. It needs no credentials.

## Storage layout

```
chat-imports/<user_id>/<chat_import_id>/<filename>
```

The first path segment must be the owner's user id; that is what the object policies check.

## Auth settings to review in the dashboard

- **Email confirmation**: if enabled, users must confirm before their first sign-in
  (the app already handles the "check your inbox" state).
- **Redirect URLs**: add `<your-app-url>/auth/callback` to the allowed redirect list.
- **Password minimum length**: set to 10+ to match validation in `src/app/(auth)/actions.ts`.
