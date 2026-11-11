-- ===========================================================================
-- 0004  Analysis layer: profiles, relationship context, memories, evidence
-- ===========================================================================
-- Analysis output is versioned. Nothing here is overwritten in place: a new
-- AnalysisVersion supersedes the previous one, so the user can always see what
-- the system believed and why.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Analysis versions
-- --------------------------------------------------------------------------
-- The common parent for every model-derived artifact, so provenance (which
-- model, which prompt, which message range) is stored once instead of repeated.

create table public.analysis_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,

  kind public.analysis_kind not null,
  status public.analysis_status not null default 'pending',
  version integer not null default 1,

  -- Range of messages this analysis considered (null = whole import history).
  source_from timestamptz,
  source_until timestamptz,
  message_count integer not null default 0,

  model_provider text,
  model_name text,
  prompt_version text,

  -- Structured output before it is projected into typed child tables.
  output jsonb,
  error_message text,

  superseded_by uuid references public.analysis_versions (id) on delete set null,

  created_at timestamptz not null default now(),
  completed_at timestamptz,

  constraint analysis_versions_version_positive check (version >= 1),
  constraint analysis_versions_message_count_non_negative check (message_count >= 0),
  constraint analysis_versions_range_ordered
    check (source_from is null or source_until is null or source_from <= source_until),
  constraint analysis_versions_completed_has_output
    check (status <> 'completed' or output is not null),
  constraint analysis_versions_output_is_object
    check (output is null or jsonb_typeof(output) = 'object'),
  constraint analysis_versions_not_self_superseding
    check (superseded_by is null or superseded_by <> id)
);

comment on table public.analysis_versions is
  'Provenance record for every model-generated artifact. New versions supersede old ones; history is preserved.';

create unique index analysis_versions_unique_version
  on public.analysis_versions (contact_id, kind, version);

create index analysis_versions_user_kind_idx
  on public.analysis_versions (user_id, kind, created_at desc);
create index analysis_versions_contact_idx on public.analysis_versions (contact_id);

-- --------------------------------------------------------------------------
-- Communication profiles
-- --------------------------------------------------------------------------
-- Two rows per contact (self + contact): how each participant writes.

create table public.communication_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  analysis_version_id uuid references public.analysis_versions (id) on delete set null,

  participant public.participant_scope not null,

  -- Rhythms and volume.
  message_count integer not null default 0,
  median_message_chars integer,
  median_response_minutes integer,
  initiates_conversations_pct public.confidence_score,

  -- Tone markers expressed 0..1 so they can be compared and visualised.
  formality public.confidence_score,
  warmth public.confidence_score,
  humour public.confidence_score,
  directness public.confidence_score,
  emoji_rate public.confidence_score,

  -- Free-form descriptive output from the analyser.
  summary text,
  sample_topics text[] not null default '{}',
  common_phrases text[] not null default '{}',

  -- Distinguishes "we have not analysed this yet" from "we analysed and found nothing".
  is_populated boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint communication_profiles_unique_participant
    unique (contact_id, participant),
  constraint communication_profiles_counts_non_negative
    check (message_count >= 0),
  constraint communication_profiles_summary_len
    check (summary is null or char_length(summary) <= 8000),
  constraint communication_profiles_median_chars_positive
    check (median_message_chars is null or median_message_chars >= 0),
  constraint communication_profiles_median_response_positive
    check (median_response_minutes is null or median_response_minutes >= 0),
  constraint communication_profiles_populated_has_summary
    check (not is_populated or summary is not null)
);

comment on table public.communication_profiles is
  'Per-participant communication style for a contact, derived from an analysis version.';

create index communication_profiles_user_idx on public.communication_profiles (user_id);
create index communication_profiles_contact_idx on public.communication_profiles (contact_id);
create index communication_profiles_analysis_version_idx
  on public.communication_profiles (analysis_version_id);

create trigger communication_profiles_set_updated_at
  before update on public.communication_profiles
  for each row execute function public.set_updated_at();

-- --------------------------------------------------------------------------
-- Relationship contexts
-- --------------------------------------------------------------------------
-- The durable "what is going on between these two people" note: how they met,
-- current dynamics, open threads, sensitivities.

create table public.relationship_contexts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  analysis_version_id uuid references public.analysis_versions (id) on delete set null,

  relationship_kind public.relationship_kind not null default 'unknown',
  -- How the relationship was described in the chat ("we met at university").
  origin_summary text,
  -- Current dynamics: distance, frequency, friction, affection.
  dynamics_summary text,
  -- Unresolved topics worth remembering ("she still owes an answer about the trip").
  open_threads text[] not null default '{}',
  -- Things to handle with care.
  sensitivities text[] not null default '{}',

  confidence public.confidence_score not null default 0,
  is_user_edited boolean not null default false,
  is_populated boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One current context per contact. History lives in analysis_versions.
  constraint relationship_contexts_unique_contact unique (contact_id),
  constraint relationship_contexts_sensitive_count
    check (array_length(sensitivities, 1) is null or array_length(sensitivities, 1) <= 50),
  constraint relationship_contexts_threads_count
    check (array_length(open_threads, 1) is null or array_length(open_threads, 1) <= 100),
  constraint relationship_contexts_populated_evidence
    check (not is_populated or dynamics_summary is not null)
);

comment on table public.relationship_contexts is
  'Current relationship understanding for a contact. Exactly one row per contact; updates are versioned via analysis_versions.';

create index relationship_contexts_user_idx on public.relationship_contexts (user_id);
create index relationship_contexts_analysis_version_idx
  on public.relationship_contexts (analysis_version_id);

create trigger relationship_contexts_set_updated_at
  before update on public.relationship_contexts
  for each row execute function public.set_updated_at();

-- --------------------------------------------------------------------------
-- Memories
-- --------------------------------------------------------------------------
-- Atomic, evidence-backed facts about a contact ("training for a marathon in
-- April", "does not drink").

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  analysis_version_id uuid references public.analysis_versions (id) on delete set null,

  category public.memory_category not null,
  status public.memory_status not null default 'active',

  -- Short, human-readable statement. This is what the reply generator sees.
  statement text not null,
  details text,
  -- Normalised topics for filtering/linking related memories.
  topics text[] not null default '{}',

  confidence public.confidence_score not null default 0,
  -- Set when the user confirms or corrects the memory themselves.
  is_user_confirmed boolean not null default false,
  is_sensitive boolean not null default false,

  -- When this fact became true / when we observed it, if the export says so.
  first_observed_at timestamptz,
  last_observed_at timestamptz,

  -- Replaced instead of deleted when a newer version contradicts it.
  superseded_by uuid references public.memories (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint memories_statement_not_blank
    check (char_length(btrim(statement)) between 1 and 500),
  constraint memories_details_len
    check (details is null or char_length(details) <= 4000),
  constraint memories_observation_range
    check (
      first_observed_at is null
      or last_observed_at is null
      or first_observed_at <= last_observed_at
    ),
  constraint memories_no_self_supersede
    check (superseded_by is null or superseded_by <> id),
  -- A superseded memory must point at its replacement, so nothing gets lost.
  constraint memories_superseded_requires_link
    check (status <> 'superseded' or superseded_by is not null)
);

comment on table public.memories is
  'Evidence-backed facts about a contact. Superseded rather than deleted so older analysis stays auditable.';

create index memories_user_contact_idx
  on public.memories (user_id, contact_id, status);
create index memories_category_idx on public.memories (contact_id, category);
create index memories_topics_idx on public.memories using gin (topics);
create index memories_analysis_version_idx on public.memories (analysis_version_id);

create trigger memories_set_updated_at
  before update on public.memories
  for each row execute function public.set_updated_at();

-- --------------------------------------------------------------------------
-- Memory evidence
-- --------------------------------------------------------------------------
-- Join table proving where a memory came from. Every memory should be able to
-- answer "why do you believe this?".

create table public.memory_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  memory_id uuid not null references public.memories (id) on delete cascade,
  -- Nullable: evidence can also come from a manual note rather than a message.
  message_id uuid references public.messages (id) on delete cascade,

  -- Verbatim supporting excerpt (kept short; the message holds the full text).
  excerpt text,
  rationale text,
  confidence public.confidence_score not null default 0,

  created_at timestamptz not null default now(),

  constraint memory_evidence_needs_source
    check (message_id is not null or excerpt is not null),
  constraint memory_evidence_excerpt_len
    check (excerpt is null or char_length(excerpt) <= 1000)
);

comment on table public.memory_evidence is
  'Links a memory to the messages (or notes) that support it.';

-- One citation per memory/message pair.
create unique index memory_evidence_unique_citation
  on public.memory_evidence (memory_id, message_id)
  where message_id is not null;

create index memory_evidence_memory_idx on public.memory_evidence (memory_id);
create index memory_evidence_message_idx on public.memory_evidence (message_id);
create index memory_evidence_user_idx on public.memory_evidence (user_id);

-- --------------------------------------------------------------------------
-- Reply drafts
-- --------------------------------------------------------------------------

create table public.reply_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  analysis_version_id uuid references public.analysis_versions (id) on delete set null,

  -- The incoming message being answered (the "prompt" for the draft).
  in_reply_to_message_id uuid references public.messages (id) on delete set null,

  status public.reply_draft_status not null default 'draft',
  tone text,
  body text not null,
  -- Which memories the generator leaned on, for explainability.
  used_memory_ids uuid[] not null default '{}',

  model_provider text,
  model_name text,
  prompt_version text,

  -- Set when the user accepts the draft, so suggestion quality can be measured.
  accepted_at timestamptz,
  edited_body text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint reply_drafts_body_not_blank
    check (char_length(btrim(body)) between 1 and 4000),
  constraint reply_drafts_edited_body_len
    check (edited_body is null or char_length(edited_body) <= 4000),
  constraint reply_drafts_accepted_has_timestamp
    check (status not in ('accepted', 'edited') or accepted_at is not null),
  constraint reply_drafts_edited_has_body
    check (status <> 'edited' or edited_body is not null)
);

comment on table public.reply_drafts is
  'Generated reply suggestions. Drafts are never sent automatically: Moti AI does not automate WhatsApp.';

create index reply_drafts_user_contact_idx
  on public.reply_drafts (user_id, contact_id, created_at desc);
create index reply_drafts_status_idx on public.reply_drafts (contact_id, status);
create index reply_drafts_in_reply_to_idx on public.reply_drafts (in_reply_to_message_id);
create index reply_drafts_analysis_version_idx on public.reply_drafts (analysis_version_id);

create trigger reply_drafts_set_updated_at
  before update on public.reply_drafts
  for each row execute function public.set_updated_at();
