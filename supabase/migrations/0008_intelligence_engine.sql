-- ===========================================================================
-- 0008  Phase 2: intelligence engine support
-- ===========================================================================
-- Adds what the analysis pipeline needs and nothing more:
--   * provenance on evidence (who said it, when, and whether it is a direct
--     quote or an interpretation),
--   * a stable fingerprint on memories so re-running analysis cannot create
--     duplicates,
--   * an idempotent run record per (contact, kind, input hash),
--   * a temporal snapshot so two analyses can actually be compared.
-- ===========================================================================

-- --- Evidence provenance ---------------------------------------------------

create type public.evidence_status as enum (
  'direct',        -- the message says this, quoted verbatim
  'inferred',      -- a reasonable reading of the message, flagged as such
  'user_asserted'  -- the user typed or confirmed it themselves
);

comment on type public.evidence_status is
  'How strongly a piece of evidence supports a memory. Interpretations are never presented as facts.';

alter table public.memory_evidence
  add column evidence_status public.evidence_status not null default 'direct',
  -- Preserved verbatim from the export, never re-derived from the contact name.
  add column speaker_label text,
  add column said_at timestamptz,
  -- The message this evidence was drawn from, kept even if the row is unlinked.
  add column source_message_id uuid;

comment on column public.memory_evidence.speaker_label is
  'Original sender label from the export, so attribution survives even if a contact is renamed.';
comment on column public.memory_evidence.said_at is
  'Timestamp of the cited message, copied at analysis time for stable ordering.';

create index memory_evidence_status_idx on public.memory_evidence (memory_id, evidence_status);

-- --- Memory fingerprinting -------------------------------------------------
-- Re-running analysis over the same conversation must not duplicate a memory.
-- The fingerprint hashes the normalised statement, so wording variants collapse.

alter table public.memories
  add column fingerprint text,
  add column updated_by_run_id uuid;

comment on column public.memories.fingerprint is
  'sha256 of the normalised statement, used to prevent duplicate memories across analysis runs.';

-- Only *active* memories are deduplicated: a superseded memory may legitimately
-- share a fingerprint with its replacement.
create unique index memories_active_fingerprint_key
  on public.memories (contact_id, fingerprint)
  where status = 'active' and fingerprint is not null;

-- --- Idempotent analysis runs ----------------------------------------------
-- One row per (contact, kind, input). Retrying a failed run resumes it; retrying
-- a completed run returns the existing result instead of re-running the model.

create table public.analysis_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,

  kind public.analysis_kind not null,
  -- sha256 over the exact transcript + prompt version sent to the analyser.
  input_hash text not null,
  -- How much history this run covered. Grows as later imports extend the window.
  input_messages integer not null default 0,
  status public.analysis_status not null default 'pending',

  analysis_version_id uuid references public.analysis_versions (id) on delete set null,

  attempts integer not null default 0,
  error_message text,
  -- Token/latency accounting, so cost is attributable per run.
  duration_ms integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,

  constraint analysis_runs_input_hash_shape check (input_hash ~ '^[a-f0-9]{64}$'),
  constraint analysis_runs_attempts_non_negative check (attempts >= 0),
  constraint analysis_runs_messages_non_negative check (input_messages >= 0),
  constraint analysis_runs_completed_has_version
    check (status <> 'completed' or analysis_version_id is not null)
);

comment on table public.analysis_runs is
  'Idempotency + audit record for analysis execution. One row per (contact, kind, input hash).';

create unique index analysis_runs_unique_input
  on public.analysis_runs (contact_id, kind, input_hash);

create index analysis_runs_contact_idx on public.analysis_runs (contact_id, kind, created_at desc);

create trigger analysis_runs_set_updated_at
  before update on public.analysis_runs
  for each row execute function public.set_updated_at();

-- --- Temporal snapshots ----------------------------------------------------
-- A compact, comparable summary of "what we knew" after each analysis, so a
-- later import can be diffed against it without re-reading every message.

create table public.conversation_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  analysis_version_id uuid references public.analysis_versions (id) on delete set null,

  -- Everything the snapshot covers: messages up to this instant.
  cutoff_at timestamptz not null,
  message_count integer not null default 0,

  -- Typed, schema-validated summary: topics, plans, open threads, memory
  -- fingerprints. Stored as jsonb because it is read whole, never queried into.
  data jsonb not null,

  created_at timestamptz not null default now(),

  constraint conversation_snapshots_data_is_object
    check (jsonb_typeof(data) = 'object'),
  constraint conversation_snapshots_message_count_non_negative
    check (message_count >= 0)
);

comment on table public.conversation_snapshots is
  'Point-in-time summary of a conversation, used to diff a new import against the previous analysis.';

create index conversation_snapshots_contact_idx
  on public.conversation_snapshots (contact_id, cutoff_at desc);

-- --- Temporal diff output --------------------------------------------------
-- Stored as an analysis_version of this kind so it inherits provenance and
-- versioning for free.

alter type public.analysis_kind add value if not exists 'temporal_diff';

-- --- Composite keys for the new tables (tenant safety, matching 0005) ------

alter table public.analysis_runs
  add constraint analysis_runs_id_user_id_key unique (id, user_id);

alter table public.analysis_runs
  drop constraint analysis_runs_contact_id_fkey;
alter table public.analysis_runs
  add constraint analysis_runs_contact_owner_fkey
  foreign key (contact_id, user_id) references public.contacts (id, user_id)
  on delete cascade;

alter table public.analysis_runs
  drop constraint analysis_runs_analysis_version_id_fkey;
alter table public.analysis_runs
  add constraint analysis_runs_version_owner_fkey
  foreign key (analysis_version_id, user_id) references public.analysis_versions (id, user_id)
  on delete set null (analysis_version_id);

alter table public.conversation_snapshots
  add constraint conversation_snapshots_id_user_id_key unique (id, user_id);

alter table public.conversation_snapshots
  drop constraint conversation_snapshots_contact_id_fkey;
alter table public.conversation_snapshots
  add constraint conversation_snapshots_contact_owner_fkey
  foreign key (contact_id, user_id) references public.contacts (id, user_id)
  on delete cascade;

alter table public.conversation_snapshots
  drop constraint conversation_snapshots_analysis_version_id_fkey;
alter table public.conversation_snapshots
  add constraint conversation_snapshots_version_owner_fkey
  foreign key (analysis_version_id, user_id) references public.analysis_versions (id, user_id)
  on delete set null (analysis_version_id);

-- --- Row Level Security ----------------------------------------------------

alter table public.analysis_runs enable row level security;
alter table public.conversation_snapshots enable row level security;

create policy "analysis_runs_select_own"
  on public.analysis_runs for select to authenticated
  using (user_id = public.current_user_id());
create policy "analysis_runs_insert_own"
  on public.analysis_runs for insert to authenticated
  with check (user_id = public.current_user_id());
create policy "analysis_runs_update_own"
  on public.analysis_runs for update to authenticated
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());
create policy "analysis_runs_delete_own"
  on public.analysis_runs for delete to authenticated
  using (user_id = public.current_user_id());

create policy "conversation_snapshots_select_own"
  on public.conversation_snapshots for select to authenticated
  using (user_id = public.current_user_id());
create policy "conversation_snapshots_insert_own"
  on public.conversation_snapshots for insert to authenticated
  with check (user_id = public.current_user_id());
create policy "conversation_snapshots_update_own"
  on public.conversation_snapshots for update to authenticated
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());
create policy "conversation_snapshots_delete_own"
  on public.conversation_snapshots for delete to authenticated
  using (user_id = public.current_user_id());

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update, delete on public.analysis_runs to authenticated;
    grant select, insert, update, delete on public.conversation_snapshots to authenticated;
  end if;
end;
$$;
