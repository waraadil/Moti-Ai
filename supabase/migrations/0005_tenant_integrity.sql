-- ===========================================================================
-- 0005  Tenant integrity
-- ===========================================================================
-- Row Level Security keeps the API honest, but RLS alone cannot stop a
-- server-side (service role) write from attaching one user's message to
-- another user's contact: the foreign key would still be satisfied.
--
-- Fix: make every cross-entity reference *composite* with user_id. A row can
-- only point at a parent that belongs to the same user, enforced by Postgres
-- itself rather than by application code that might be forgotten.
--
-- Requires PostgreSQL 15+ for `on delete set null (column)` on composite keys.
-- ===========================================================================

-- --- Composite parent keys ------------------------------------------------

alter table public.contacts
  add constraint contacts_id_user_id_key unique (id, user_id);

alter table public.chat_imports
  add constraint chat_imports_id_user_id_key unique (id, user_id);

alter table public.messages
  add constraint messages_id_user_id_key unique (id, user_id);

alter table public.analysis_versions
  add constraint analysis_versions_id_user_id_key unique (id, user_id);

alter table public.memories
  add constraint memories_id_user_id_key unique (id, user_id);

-- --- contact_aliases ------------------------------------------------------

alter table public.contact_aliases
  drop constraint contact_aliases_contact_id_fkey;
alter table public.contact_aliases
  add constraint contact_aliases_contact_owner_fkey
  foreign key (contact_id, user_id) references public.contacts (id, user_id)
  on delete cascade;

-- --- chat_imports ---------------------------------------------------------

alter table public.chat_imports
  drop constraint chat_imports_contact_id_fkey;
alter table public.chat_imports
  add constraint chat_imports_contact_owner_fkey
  foreign key (contact_id, user_id) references public.contacts (id, user_id)
  on delete set null (contact_id);

-- --- messages -------------------------------------------------------------

alter table public.messages
  drop constraint messages_chat_import_id_fkey;
alter table public.messages
  add constraint messages_import_owner_fkey
  foreign key (chat_import_id, user_id) references public.chat_imports (id, user_id)
  on delete cascade;

alter table public.messages
  drop constraint messages_contact_id_fkey;
alter table public.messages
  add constraint messages_contact_owner_fkey
  foreign key (contact_id, user_id) references public.contacts (id, user_id)
  on delete cascade;

-- --- analysis_versions ----------------------------------------------------

alter table public.analysis_versions
  drop constraint analysis_versions_contact_id_fkey;
alter table public.analysis_versions
  add constraint analysis_versions_contact_owner_fkey
  foreign key (contact_id, user_id) references public.contacts (id, user_id)
  on delete cascade;

alter table public.analysis_versions
  drop constraint analysis_versions_superseded_by_fkey;
alter table public.analysis_versions
  add constraint analysis_versions_superseded_by_owner_fkey
  foreign key (superseded_by, user_id) references public.analysis_versions (id, user_id)
  on delete set null (superseded_by);

-- --- communication_profiles ----------------------------------------------

alter table public.communication_profiles
  drop constraint communication_profiles_contact_id_fkey;
alter table public.communication_profiles
  add constraint communication_profiles_contact_owner_fkey
  foreign key (contact_id, user_id) references public.contacts (id, user_id)
  on delete cascade;

alter table public.communication_profiles
  drop constraint communication_profiles_analysis_version_id_fkey;
alter table public.communication_profiles
  add constraint communication_profiles_analysis_owner_fkey
  foreign key (analysis_version_id, user_id) references public.analysis_versions (id, user_id)
  on delete set null (analysis_version_id);

-- --- relationship_contexts ------------------------------------------------

alter table public.relationship_contexts
  drop constraint relationship_contexts_contact_id_fkey;
alter table public.relationship_contexts
  add constraint relationship_contexts_contact_owner_fkey
  foreign key (contact_id, user_id) references public.contacts (id, user_id)
  on delete cascade;

alter table public.relationship_contexts
  drop constraint relationship_contexts_analysis_version_id_fkey;
alter table public.relationship_contexts
  add constraint relationship_contexts_analysis_owner_fkey
  foreign key (analysis_version_id, user_id) references public.analysis_versions (id, user_id)
  on delete set null (analysis_version_id);

-- --- memories -------------------------------------------------------------

alter table public.memories
  drop constraint memories_contact_id_fkey;
alter table public.memories
  add constraint memories_contact_owner_fkey
  foreign key (contact_id, user_id) references public.contacts (id, user_id)
  on delete cascade;

alter table public.memories
  drop constraint memories_analysis_version_id_fkey;
alter table public.memories
  add constraint memories_analysis_owner_fkey
  foreign key (analysis_version_id, user_id) references public.analysis_versions (id, user_id)
  on delete set null (analysis_version_id);

alter table public.memories
  drop constraint memories_superseded_by_fkey;
alter table public.memories
  add constraint memories_superseded_by_owner_fkey
  foreign key (superseded_by, user_id) references public.memories (id, user_id)
  on delete set null (superseded_by);

-- --- memory_evidence ------------------------------------------------------

alter table public.memory_evidence
  drop constraint memory_evidence_memory_id_fkey;
alter table public.memory_evidence
  add constraint memory_evidence_memory_owner_fkey
  foreign key (memory_id, user_id) references public.memories (id, user_id)
  on delete cascade;

alter table public.memory_evidence
  drop constraint memory_evidence_message_id_fkey;
alter table public.memory_evidence
  add constraint memory_evidence_message_owner_fkey
  foreign key (message_id, user_id) references public.messages (id, user_id)
  on delete cascade;

-- --- reply_drafts ---------------------------------------------------------

alter table public.reply_drafts
  drop constraint reply_drafts_contact_id_fkey;
alter table public.reply_drafts
  add constraint reply_drafts_contact_owner_fkey
  foreign key (contact_id, user_id) references public.contacts (id, user_id)
  on delete cascade;

alter table public.reply_drafts
  drop constraint reply_drafts_analysis_version_id_fkey;
alter table public.reply_drafts
  add constraint reply_drafts_analysis_owner_fkey
  foreign key (analysis_version_id, user_id) references public.analysis_versions (id, user_id)
  on delete set null (analysis_version_id);

alter table public.reply_drafts
  drop constraint reply_drafts_in_reply_to_message_id_fkey;
alter table public.reply_drafts
  add constraint reply_drafts_in_reply_to_owner_fkey
  foreign key (in_reply_to_message_id, user_id) references public.messages (id, user_id)
  on delete set null (in_reply_to_message_id);

-- ===========================================================================
-- Semantic consistency: rows must agree with their parents, not just share an
-- owner. These checks run in the database because a parser bug must not be
-- able to fabricate a conversation.
-- ===========================================================================

create or replace function public.assert_message_matches_import()
returns trigger
language plpgsql
as $$
declare
  import_contact uuid;
begin
  select contact_id into import_contact
  from public.chat_imports
  where id = new.chat_import_id;

  if import_contact is not null and import_contact <> new.contact_id then
    raise exception
      'message contact % does not match its chat import contact %',
      new.contact_id, import_contact
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger messages_assert_import_consistency
  before insert or update on public.messages
  for each row execute function public.assert_message_matches_import();

create or replace function public.assert_evidence_matches_memory()
returns trigger
language plpgsql
as $$
declare
  memory_contact uuid;
  evidence_contact uuid;
begin
  if new.message_id is null then
    return new;
  end if;

  select contact_id into memory_contact from public.memories where id = new.memory_id;
  select contact_id into evidence_contact from public.messages where id = new.message_id;

  if memory_contact is distinct from evidence_contact then
    raise exception
      'evidence message belongs to contact %, but the memory belongs to contact %',
      evidence_contact, memory_contact
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger memory_evidence_assert_contact_match
  before insert or update on public.memory_evidence
  for each row execute function public.assert_evidence_matches_memory();

comment on function public.assert_message_matches_import() is
  'Guarantees a message cannot be attached to a chat import for a different contact.';
comment on function public.assert_evidence_matches_memory() is
  'Guarantees memory evidence cites a message from the same conversation.';
