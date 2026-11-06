-- ===========================================================================
-- 0007  Storage buckets and object policies
-- ===========================================================================
-- Two private buckets:
--   chat-imports : uploaded WhatsApp export files (.txt/.zip)
--   analysis     : generated artifacts (if we ever persist large outputs)
--
-- Objects are stored under a path whose first segment is the owner's user id:
--   <user_id>/<chat_import_id>/<filename>
--
-- Policies read that first segment. Files are never public: access goes
-- through short-lived signed URLs issued server-side.
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'chat-imports',
    'chat-imports',
    false,
    52428800, -- 50 MB
    array['text/plain', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream']
  ),
  (
    'analysis',
    'analysis',
    false,
    10485760, -- 10 MB
    array['application/json', 'text/plain']
  )
on conflict (id) do nothing;

-- --- chat-imports ---------------------------------------------------------
-- Owner is determined by the leading path segment, which must equal auth.uid().

create policy "chat_imports_objects_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'chat-imports'
    and (storage.foldername(name))[1] = public.current_user_id()::text
  );

create policy "chat_imports_objects_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'chat-imports'
    and (storage.foldername(name))[1] = public.current_user_id()::text
  );

create policy "chat_imports_objects_update_own"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'chat-imports'
    and (storage.foldername(name))[1] = public.current_user_id()::text
  )
  with check (
    bucket_id = 'chat-imports'
    and (storage.foldername(name))[1] = public.current_user_id()::text
  );

create policy "chat_imports_objects_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'chat-imports'
    and (storage.foldername(name))[1] = public.current_user_id()::text
  );

-- --- analysis -------------------------------------------------------------

create policy "analysis_objects_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'analysis'
    and (storage.foldername(name))[1] = public.current_user_id()::text
  );

create policy "analysis_objects_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'analysis'
    and (storage.foldername(name))[1] = public.current_user_id()::text
  );

create policy "analysis_objects_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'analysis'
    and (storage.foldername(name))[1] = public.current_user_id()::text
  );
