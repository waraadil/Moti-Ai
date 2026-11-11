-- ===========================================================================
-- 0003  Conversation imports and messages
-- ===========================================================================
-- ChatImports record one uploaded export file and how far parsing got.
-- Messages belong to exactly one import and exactly one contact, and every
-- message carries user_id so RLS never needs a join.
-- ===========================================================================

create table public.chat_imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  source public.chat_import_source not null,
  status public.chat_import_status not null default 'uploaded',

  -- Storage object path inside the private `chat-imports` bucket.
  storage_path text not null,
  original_filename text not null,
  byte_size bigint not null default 0,
  -- SHA-256 of the file contents, used to detect re-uploads of the same export.
  checksum text,

  -- Parsing telemetry, filled in as the import progresses.
  total_lines integer not null default 0,
  parsed_messages integer not null default 0,
  skipped_lines integer not null default 0,
  detected_participants text[] not null default '{}',
  -- Populated when status = 'failed' or 'needs_review'.
  error_message text,
  -- Anything the parser could not classify with confidence.
  parse_warnings jsonb not null default '[]'::jsonb,

  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chat_imports_filename_not_blank
    check (char_length(btrim(original_filename)) between 1 and 255),
  constraint chat_imports_byte_size_positive check (byte_size >= 0),
  constraint chat_imports_counts_non_negative
    check (total_lines >= 0 and parsed_messages >= 0 and skipped_lines >= 0),
  constraint chat_imports_checksum_shape
    check (checksum is null or checksum ~ '^[a-f0-9]{64}$'),
  constraint chat_imports_warnings_is_array
    check (jsonb_typeof(parse_warnings) = 'array'),
  constraint chat_imports_completed_has_timestamp
    check (status <> 'completed' or completed_at is not null)
);

comment on table public.chat_imports is
  'One uploaded WhatsApp export file and its parse progress. Source files live in private Storage.';

create index chat_imports_user_created_idx
  on public.chat_imports (user_id, created_at desc);
create index chat_imports_contact_idx on public.chat_imports (contact_id);
create index chat_imports_user_status_idx on public.chat_imports (user_id, status);

-- Prevent the same export file being imported twice for the same user.
create unique index chat_imports_user_checksum_key
  on public.chat_imports (user_id, checksum)
  where checksum is not null;

create trigger chat_imports_set_updated_at
  before update on public.chat_imports
  for each row execute function public.set_updated_at();

-- --------------------------------------------------------------------------
-- Messages
-- --------------------------------------------------------------------------

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  chat_import_id uuid not null references public.chat_imports (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,

  direction public.message_direction not null,
  kind public.message_kind not null default 'text',

  -- The sender label exactly as it appears in the export. Kept so the user can
  -- re-map attribution without re-uploading, and so system messages stay legible.
  sender_label text,
  -- Null for system messages and for outgoing/incoming rows we cannot attribute.
  sent_at timestamptz,

  body text,
  -- Original unparsed line(s), retained for auditability of the parser.
  raw_line text,
  line_number integer,

  -- Media metadata captured from export placeholders ("IMG-20230101-WA0001.jpg
  -- (file attached)"). Bytes are not parsed in this milestone.
  media_filename text,
  is_forwarded boolean not null default false,

  -- Deterministic fingerprint of the source row, so re-parsing an import is
  -- idempotent instead of duplicating messages.
  source_fingerprint text not null,

  created_at timestamptz not null default now(),

  constraint messages_body_or_metadata
    check (
      body is not null
      or media_filename is not null
      or kind in ('system', 'deleted', 'missed_call')
    ),
  constraint messages_body_len check (body is null or char_length(body) <= 10000),
  constraint messages_line_number_positive
    check (line_number is null or line_number >= 0),
  constraint messages_outgoing_or_incoming_needs_time
    check (direction in ('system', 'unknown') or sent_at is not null),
  constraint messages_fingerprint_shape
    check (char_length(source_fingerprint) between 8 and 128)
);

comment on table public.messages is
  'A single parsed message from a chat import. Messages are immutable once written.';

create unique index messages_import_fingerprint_key
  on public.messages (chat_import_id, source_fingerprint);

create index messages_contact_sent_at_idx
  on public.messages (user_id, contact_id, sent_at desc nulls last);
create index messages_import_idx on public.messages (chat_import_id);
create index messages_user_sent_at_idx on public.messages (user_id, sent_at desc nulls last);

-- Trigram index for searching message text.
create index messages_body_trgm_idx
  on public.messages using gin (body gin_trgm_ops);

comment on index public.messages_body_trgm_idx is
  'Supports the contact conversation search (ILIKE / similarity).';

-- Messages are an append-only log; correcting them would silently change the
-- evidence behind existing analysis versions.
create or replace function public.reject_message_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'messages are immutable: create a new chat import instead of editing history'
    using errcode = 'check_violation';
end;
$$;

create trigger messages_no_update
  before update on public.messages
  for each row execute function public.reject_message_mutation();

comment on function public.reject_message_mutation() is
  'Blocks in-place edits of parsed messages so analysis evidence stays reproducible.';
