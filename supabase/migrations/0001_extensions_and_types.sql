-- ===========================================================================
-- 0001  Extensions, enums and shared helpers
-- ===========================================================================
-- Moti AI foundation schema. Every table is owned by a user and protected by
-- Row Level Security (see 0006_row_level_security.sql).
-- ===========================================================================

create extension if not exists "pgcrypto"; -- gen_random_uuid()
create extension if not exists "pg_trgm"; -- fuzzy search over message bodies

-- --- Enumerated value domains ---------------------------------------------
-- Enums keep the database honest about the small, stable vocabularies the
-- analysis pipeline depends on. Anything that is likely to grow (topics,
-- traits) is stored as jsonb / text[] instead.

create type public.relationship_kind as enum (
  'family',
  'friend',
  'partner',
  'colleague',
  'acquaintance',
  'client',
  'other',
  'unknown'
);

create type public.chat_import_source as enum (
  -- Only offline exports are supported. Moti AI does not automate WhatsApp.
  'whatsapp_txt_export',
  'whatsapp_zip_export'
);

create type public.chat_import_status as enum (
  'uploaded',
  'parsing',
  'needs_review',
  'completed',
  'failed'
);

create type public.message_direction as enum (
  'outgoing', -- sent by the Moti user
  'incoming', -- sent by the contact
  'system',   -- "Messages are end-to-end encrypted", joins, etc.
  'unknown'   -- export could not attribute the sender
);

create type public.message_kind as enum (
  'text',
  'media',
  'missed_call',
  'deleted',
  'system'
);

create type public.participant_scope as enum (
  'self',    -- how the Moti user communicates with this contact
  'contact'  -- how this contact communicates with the Moti user
);

create type public.analysis_kind as enum (
  'communication_profile',
  'relationship_context',
  'memory_extraction',
  'reply_suggestion'
);

create type public.analysis_status as enum (
  'pending',
  'running',
  'completed',
  'failed',
  'superseded'
);

create type public.memory_category as enum (
  'preference',
  'life_event',
  'relationship',
  'boundary',
  'goal',
  'routine',
  'sensitive'
);

create type public.memory_status as enum (
  'active',
  'superseded',
  'archived'
);

create type public.reply_draft_status as enum (
  'draft',
  'accepted',
  'edited',
  'discarded'
);

-- --- Shared helpers -------------------------------------------------------

-- Keeps `updated_at` accurate without trusting the client.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Wrapper around auth.uid() so policies stay readable, and so that the
-- helper has exactly one definition to audit.
create or replace function public.current_user_id()
returns uuid
language sql
stable
as $$
  select auth.uid();
$$;

comment on function public.set_updated_at() is
  'Trigger function: stamps updated_at on row modification.';
comment on function public.current_user_id() is
  'Returns the authenticated user id from the current Supabase request.';

-- Every "how sure are we" number in the schema is normalised to 0..1.
do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'confidence_score' and n.nspname = 'public'
  ) then
    create domain public.confidence_score as numeric(4, 3)
      check (value >= 0 and value <= 1);
  end if;
end;
$$;

comment on domain public.confidence_score is
  'Normalised 0..1 confidence used by profiles, memories and evidence.';
