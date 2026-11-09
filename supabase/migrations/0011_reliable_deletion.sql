-- --- Reliable, resumable deletion -------------------------------------------
--
-- Problem this migration solves
-- -----------------------------
-- The previous implementation issued one DELETE per table from the application.
-- A failure on table 5 left tables 1-4 already committed and unrecoverable
-- knowledge of *which* rows had gone. The user was then told "nothing was
-- changed", which was simply false.
--
-- Three mechanisms replace it:
--
--   1. Deletion runs inside ONE database function, so it is a single
--      transaction. Either every row goes, or none does. PostgREST has no
--      multi-statement transaction, so this cannot be done from the client —
--      it has to be a function.
--
--   2. Storage objects cannot participate in a database transaction. So they
--      are tracked in a queue (data_cleanup_jobs) rather than being deleted
--      inline. File removal runs *after* the rows are gone, retries safely, and
--      its failures are recorded instead of being hidden.
--
--   3. A deletion is only reported complete when the queue is empty for that
--      scope. Until then the UI can say honestly: records deleted, files still
--      pending.
--
-- Re-running any function here is safe: every step is idempotent.

-- --- Purpose a user's deletion ----------------------------------------------
--
-- Why this exists instead of deleting auth.users directly:
--   Supabase's auth schema is owned by Supabase. Deleting from it from an
--   application migration is unsupported and would break sign-in flows in ways
--   that are hard to reason about. So the *personal content* in the profile is
--   removed here, and the credential identity itself is left to the auth layer.
--
-- What remains afterwards, stated precisely:
--   profiles.id    - a bare UUID, which is also the auth.users primary key.
--                    It is the account. It reveals nothing about the person.
--   profiles.email - NULLed unless the user keeps it.
--   profiles.display_name - replaced with a neutral placeholder.
--   timezone       - reset to UTC.
--
-- The row cannot be dropped entirely while the account exists: profile.id has
-- a foreign key to auth.users and the on-delete cascade runs the other way.

create or replace function public.anonymise_profile(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'anonymise_profile: caller may only anonymise their own profile'
      using errcode = '42501';
  end if;

  update public.profiles
     set email = null,
         display_name = 'Deleted account',
         timezone = 'UTC',
         updated_at = now()
   where id = p_user_id;
end;
$$;

comment on function public.anonymise_profile(uuid) is
  'Removes identifying content from the caller''s own profile while leaving the auth account intact. Irreversible.';

-- --- Cleanup queue for storage objects --------------------------------------
--
-- Rows here mean: "a file that belonged to deleted data may still exist in
-- private storage". It is a to-do list, not a log. A row is deleted only when
-- the storage removal actually succeeded.

create type public.data_cleanup_kind as enum ('chat_import_object');

create table public.data_cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,

  kind public.data_cleanup_kind not null default 'chat_import_object',
  bucket text not null,
  object_path text not null,

  -- Attempt accounting. A job that keeps failing is visible, not silent.
  attempts integer not null default 0,
  last_error text,
  last_attempt_at timestamptz,

  created_at timestamptz not null default now(),

  -- The same object should not be queued twice.
  unique (bucket, object_path)
);

comment on table public.data_cleanup_jobs is
  'Storage objects whose database rows are already gone. Rows persist until removal succeeds, so a deletion is never reported complete while a file remains.';

create index data_cleanup_jobs_user_idx on public.data_cleanup_jobs (user_id, created_at);

alter table public.data_cleanup_jobs enable row level security;

-- Owners may see and clear their own queue. The application needs to insert and
-- delete; it never needs to update, because a retry either removes the row or
-- records a new attempt via the function below.

create policy "data_cleanup_jobs_owner_select" on public.data_cleanup_jobs
  for select using (auth.uid() = user_id);

create policy "data_cleanup_jobs_owner_insert" on public.data_cleanup_jobs
  for insert with check (auth.uid() = user_id);

create policy "data_cleanup_jobs_owner_delete" on public.data_cleanup_jobs
  for delete using (auth.uid() = user_id);

-- --- The deletion functions -------------------------------------------------
--
-- Both take no user id. Identity comes from auth.uid(), so a caller cannot ask
-- the database to delete somebody else's data even if the application layer were
-- compromised. This is stricter than the previous client-side filtering, and it
-- is the main security improvement in this migration.
--
-- Both return the same shape so callers need one code path:
--   deleted        : table name -> number of rows removed
--   purge_contact  : the contact id this scoped the deletion (null = whole account)
--   queued_files   : storage objects now queued for removal
--   complete       : false while any cleanup job remains for this scope

create or replace function public.delete_contact_data(p_contact_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_deleted jsonb := '{}'::jsonb;
  v_queued integer := 0;
  v_count integer;
  v_rows_remain integer;
begin
  if v_user_id is null then
    raise exception 'delete_contact_data: not authenticated' using errcode = '42501';
  end if;

  -- Ownership check. Without this, a caller could pass any contact id.
  perform 1
     from public.contacts
    where id = p_contact_id and user_id = v_user_id;

  if not found then
    raise exception 'delete_contact_data: contact not found or not yours'
      using errcode = '42501';
  end if;

  -- Queue storage objects BEFORE removing their rows, so the file can never
  -- become unreachable: the path is captured while it is still known.
  with moved as (
    insert into public.data_cleanup_jobs (user_id, kind, bucket, object_path)
    select v_user_id, 'chat_import_object', 'chat-imports', i.storage_path
      from public.chat_imports i
     where i.user_id = v_user_id
       and i.contact_id = p_contact_id
       and i.storage_path is not null
    on conflict (bucket, object_path) do nothing
    returning 1
  )
  select count(*) into v_queued from moved;

  -- Derived data first, sources last. Order matters less inside a transaction
  -- than it did before, but it keeps the meaning of an interrupted run clear if
  -- the function is ever split.
  delete from public.away_prepared_replies where user_id = v_user_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('away_prepared_replies', v_count); end if;

  delete from public.away_events where user_id = v_user_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('away_events', v_count); end if;

  delete from public.away_contact_permissions where user_id = v_user_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('away_contact_permissions', v_count); end if;

  delete from public.reply_drafts where user_id = v_user_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('reply_drafts', v_count); end if;

  delete from public.conversation_snapshots where user_id = v_user_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('conversation_snapshots', v_count); end if;

  delete from public.analysis_runs where user_id = v_user_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('analysis_runs', v_count); end if;

  delete from public.analysis_versions where user_id = v_user_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('analysis_versions', v_count); end if;

  /*
   * memory_evidence has no contact_id of its own — it hangs off a memory (and
   * optionally a message). Scoping through the parent memory is the only correct
   * way to delete the evidence for one contact.
   */
  delete from public.memory_evidence e
        using public.memories m
        where e.user_id = v_user_id
          and m.id = e.memory_id
          and m.contact_id = p_contact_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('memory_evidence', v_count); end if;

  delete from public.memories where user_id = v_user_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('memories', v_count); end if;

  delete from public.relationship_contexts where user_id = v_user_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('relationship_contexts', v_count); end if;

  delete from public.communication_profiles where user_id = v_user_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('communication_profiles', v_count); end if;

  delete from public.contact_aliases where user_id = v_user_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('contact_aliases', v_count); end if;

  delete from public.messages where user_id = v_user_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('messages', v_count); end if;

  delete from public.chat_imports where user_id = v_user_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('chat_imports', v_count); end if;

  delete from public.contacts where user_id = v_user_id and id = p_contact_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('contacts', v_count); end if;

  /*
   * Honest completion: the rows are gone by the time this runs, but the deletion
   * is not finished while a file may still exist. Count the queue directly —
   * joining to chat_imports here would match nothing, because those rows were
   * deleted moments ago in this same transaction.
   */
  select count(*) into v_rows_remain
    from public.data_cleanup_jobs q
   where q.user_id = v_user_id;

  return jsonb_build_object(
    'deleted', v_deleted,
    'purge_contact', p_contact_id,
    'queued_files', v_queued,
    'complete', v_rows_remain = 0
  );
end;
$$;

comment on function public.delete_contact_data(uuid) is
  'Deletes one contact and all derived rows in a single transaction. Storage removal is queued, not attempted here.';

create or replace function public.delete_all_user_data(p_anonymise boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_deleted jsonb := '{}'::jsonb;
  v_queued integer := 0;
  v_count integer;
  v_pending integer;
begin
  if v_user_id is null then
    raise exception 'delete_all_user_data: not authenticated' using errcode = '42501';
  end if;

  -- Capture every storage path while the rows still exist.
  with moved as (
    insert into public.data_cleanup_jobs (user_id, kind, bucket, object_path)
    select v_user_id, 'chat_import_object', 'chat-imports', i.storage_path
      from public.chat_imports i
     where i.user_id = v_user_id
       and i.storage_path is not null
    on conflict (bucket, object_path) do nothing
    returning 1
  )
  select count(*) into v_queued from moved;

  delete from public.away_prepared_replies where user_id = v_user_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('away_prepared_replies', v_count); end if;

  delete from public.away_events where user_id = v_user_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('away_events', v_count); end if;

  delete from public.away_contact_permissions where user_id = v_user_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('away_contact_permissions', v_count); end if;

  delete from public.away_settings where user_id = v_user_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('away_settings', v_count); end if;

  delete from public.reply_drafts where user_id = v_user_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('reply_drafts', v_count); end if;

  delete from public.conversation_snapshots where user_id = v_user_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('conversation_snapshots', v_count); end if;

  delete from public.analysis_runs where user_id = v_user_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('analysis_runs', v_count); end if;

  delete from public.analysis_versions where user_id = v_user_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('analysis_versions', v_count); end if;

  delete from public.memory_evidence where user_id = v_user_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('memory_evidence', v_count); end if;

  delete from public.memories where user_id = v_user_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('memories', v_count); end if;

  delete from public.relationship_contexts where user_id = v_user_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('relationship_contexts', v_count); end if;

  delete from public.communication_profiles where user_id = v_user_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('communication_profiles', v_count); end if;

  delete from public.contact_aliases where user_id = v_user_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('contact_aliases', v_count); end if;

  delete from public.messages where user_id = v_user_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('messages', v_count); end if;

  delete from public.chat_imports where user_id = v_user_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('chat_imports', v_count); end if;

  delete from public.contacts where user_id = v_user_id;
  get diagnostics v_count = row_count; if v_count > 0 then v_deleted := v_deleted || jsonb_build_object('contacts', v_count); end if;

  /*
   * Personal profile content. This is a separate, explicit step: the caller has
   * to ask for it, and it cannot be undone. What survives is the bare UUID that
   * the auth account is keyed by — no name, no email, no timezone.
   */
  if p_anonymise then
    update public.profiles
       set email = null,
           display_name = 'Deleted account',
           timezone = 'UTC',
           updated_at = now()
     where id = v_user_id;
    v_deleted := v_deleted || jsonb_build_object('profile_anonymised', 1);
  end if;

  select count(*) into v_pending
    from public.data_cleanup_jobs q
   where q.user_id = v_user_id;

  return jsonb_build_object(
    'deleted', v_deleted,
    'purge_contact', null,
    'queued_files', v_queued,
    'complete', v_pending = 0
  );
end;
$$;

comment on function public.delete_all_user_data(boolean) is
  'Deletes every row belonging to the caller in one transaction, optionally anonymising the profile. Storage removal is queued.';

-- --- Bookkeeping for retries -------------------------------------------------

create or replace function public.record_cleanup_failure(p_job_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.data_cleanup_jobs
     set attempts = attempts + 1,
         last_error = left(coalesce(p_error, 'unknown error'), 500),
         last_attempt_at = now()
   where id = p_job_id
     and user_id = auth.uid();
end;
$$;

comment on function public.record_cleanup_failure(uuid, text) is
  'Records a failed storage removal so the deletion is not reported complete.';

-- --- Privileges --------------------------------------------------------------
--
-- Functions run as the definer and check auth.uid() themselves, so they need to
-- be callable by authenticated users. anon gets nothing.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update, delete on public.data_cleanup_jobs to authenticated;
    revoke all on public.data_cleanup_jobs from anon;

    grant execute on function public.delete_contact_data(uuid) to authenticated;
    grant execute on function public.delete_all_user_data(boolean) to authenticated;
    grant execute on function public.anonymise_profile(uuid) to authenticated;
    grant execute on function public.record_cleanup_failure(uuid, text) to authenticated;
  end if;
end;
$$;
