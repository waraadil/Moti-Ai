-- ===========================================================================
-- 0006  Row Level Security
-- ===========================================================================
-- Every table is readable/writable only by its owner. The browser never gets a
-- key with more power than this, and the service-role key bypasses RLS only in
-- server-side jobs that already scope their queries by user_id.
--
-- Pattern: user_id = public.current_user_id() (auth.uid()).
-- profiles uses its primary key instead of user_id.
-- ===========================================================================

alter table public.profiles enable row level security;
alter table public.contacts enable row level security;
alter table public.contact_aliases enable row level security;
alter table public.chat_imports enable row level security;
alter table public.messages enable row level security;
alter table public.analysis_versions enable row level security;
alter table public.communication_profiles enable row level security;
alter table public.relationship_contexts enable row level security;
alter table public.memories enable row level security;
alter table public.memory_evidence enable row level security;
alter table public.reply_drafts enable row level security;

-- --- profiles -------------------------------------------------------------
-- Readable and editable by the owner. Creation happens through the
-- handle_new_user() trigger, so clients never insert directly.

create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using (id = public.current_user_id());

create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (id = public.current_user_id())
  with check (id = public.current_user_id());

-- --- Owner tables ---------------------------------------------------------
-- Full CRUD for the owner on every user-scoped table. Written as a loop so the
-- policy set stays uniform and impossible to forget for a new table.

do $$
declare
  tbl text;
  owner_tables text[] := array[
    'contacts',
    'contact_aliases',
    'chat_imports',
    'messages',
    'analysis_versions',
    'communication_profiles',
    'relationship_contexts',
    'memories',
    'memory_evidence',
    'reply_drafts'
  ];
begin
  foreach tbl in array owner_tables loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id = public.current_user_id())',
      tbl || '_select_own', tbl
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (user_id = public.current_user_id())',
      tbl || '_insert_own', tbl
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using (user_id = public.current_user_id()) with check (user_id = public.current_user_id())',
      tbl || '_update_own', tbl
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using (user_id = public.current_user_id())',
      tbl || '_delete_own', tbl
    );
  end loop;
end;
$$;

-- ===========================================================================
-- Privileges. Supabase creates anon/authenticated roles; grant only to
-- authenticated and let RLS do the scoping. Nothing is granted to anon.
-- Guarded so the migration also applies to a plain PostgreSQL instance.
-- ===========================================================================

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant usage on schema public to authenticated;
    grant select, insert, update, delete on all tables in schema public to authenticated;
    grant usage, select on all sequences in schema public to authenticated;
    revoke all on all tables in schema public from anon;
  end if;
end;
$$;
