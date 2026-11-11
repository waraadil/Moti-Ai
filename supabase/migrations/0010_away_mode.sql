-- --- Away Mode --------------------------------------------------------------
--
-- Away Mode lets a user record when they are unavailable, which contacts may
-- receive that information, and what Moti is allowed to prepare while they are
-- away.
--
-- Two honesty rules are encoded in the schema itself:
--
--   1. Moti cannot send messages. There is no outbound integration and no plan
--      to add a reverse-engineered one. So Away Mode prepares *drafts* and
--      records that a human still has to act on them. The column
--      `auto_send_enabled` does not exist and must not be added: the absence is
--      the guarantee.
--
--   2. Nothing leaves the app unless the user approves it. Every prepared reply
--      is a row with an approval state, and the default is 'pending'.

create type public.away_status as enum (
  'active',    -- covering right now
  'scheduled', -- covering later, per the window
  'off'        -- not covering
);

create type public.away_permission as enum (
  'draft_only',  -- prepare drafts for the user to send (the safe default)
  'silent'       -- do not draft anything for this contact at all
);

create type public.away_approval_state as enum (
  'pending',   -- waiting for the user
  'approved',  -- user accepted the prepared reply
  'rejected',  -- user discarded it
  'expired'    -- window closed before the user acted
);

create table public.away_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles (id) on delete cascade,

  status public.away_status not null default 'off',

  -- The window. Null start means "from now". A null end means open-ended, which
  -- is allowed but surfaced in the UI as "until you turn it off".
  starts_at timestamptz,
  ends_at timestamptz,

  -- What the user wants said when someone asks. Shown to the user when a
  -- prepared reply is reviewed; it is never sent on its own.
  away_message text,

  -- Applies to contacts with no explicit rule of their own.
  default_permission public.away_permission not null default 'draft_only',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint away_settings_window_ordered
    check (ends_at is null or starts_at is null or ends_at > starts_at),

  constraint away_message_length
    check (away_message is null or char_length(away_message) between 1 and 280)
);

comment on table public.away_settings is
  'Per-user Away Mode configuration. Moti never sends anything: this only governs what is prepared for the user to review.';

create table public.away_contact_permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,

  permission public.away_permission not null default 'draft_only',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, contact_id)
);

comment on table public.away_contact_permissions is
  'Per-contact overrides. A contact without a row inherits the default permission.';

create table public.away_prepared_replies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,

  -- The incoming message this was prepared for.
  in_reply_to_message_id uuid references public.messages (id) on delete set null,

  body text not null,
  state public.away_approval_state not null default 'pending',

  model_provider text,
  model_name text,
  prompt_version text,

  -- When the user approved or rejected it. Null while pending.
  decided_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint away_prepared_body_length
    check (char_length(body) between 1 and 1200),

  -- A decided reply must record when, so the activity history is truthful.
  constraint away_prepared_decided_at_consistent
    check ((state = 'pending') = (decided_at is null))
);

comment on column public.away_prepared_replies.state is
  'Defaults to pending. Moti cannot send anything, so approval means the user accepted the text for their own use.';

create index away_prepared_replies_contact_idx
  on public.away_prepared_replies (contact_id, created_at desc);

create index away_prepared_replies_pending_idx
  on public.away_prepared_replies (user_id, created_at desc)
  where state = 'pending';

-- --- Activity history --------------------------------------------------------
--
-- Phase 4 requires an auditable record of what happened while away. Kept as an
-- append-only log rather than derived state, so a later settings change cannot
-- rewrite history.

create type public.away_event_kind as enum (
  'mode_enabled',
  'mode_disabled',
  'window_expired',
  'reply_prepared',
  'reply_approved',
  'reply_rejected',
  'permission_changed'
);

create table public.away_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete cascade,

  kind public.away_event_kind not null,
  -- Short human-readable description, safe to show in the UI.
  detail text,
  -- Structured extras (e.g. previous and new permission).
  data jsonb,

  created_at timestamptz not null default now()
);

create index away_events_user_idx on public.away_events (user_id, created_at desc);

-- --- updated_at maintenance --------------------------------------------------
--
-- Reuses public.set_updated_at() from 0001 rather than defining a second
-- trigger function with the same job.

drop trigger if exists away_settings_set_updated_at on public.away_settings;
create trigger away_settings_set_updated_at
  before update on public.away_settings
  for each row execute function public.set_updated_at();

drop trigger if exists away_contact_permissions_set_updated_at
  on public.away_contact_permissions;
create trigger away_contact_permissions_set_updated_at
  before update on public.away_contact_permissions
  for each row execute function public.set_updated_at();

drop trigger if exists away_prepared_replies_set_updated_at
  on public.away_prepared_replies;
create trigger away_prepared_replies_set_updated_at
  before update on public.away_prepared_replies
  for each row execute function public.set_updated_at();

-- --- Row level security ------------------------------------------------------
--
-- Owner-only access, matching the rest of the schema. The activity log is
-- readable and insertable by its owner, but never updatable or deletable: a log
-- the subject can rewrite proves nothing.

alter table public.away_settings enable row level security;
alter table public.away_contact_permissions enable row level security;
alter table public.away_prepared_replies enable row level security;
alter table public.away_events enable row level security;

create policy "away_settings_owner_all" on public.away_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "away_permissions_owner_all" on public.away_contact_permissions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "away_replies_owner_select" on public.away_prepared_replies
  for select using (auth.uid() = user_id);

create policy "away_replies_owner_insert" on public.away_prepared_replies
  for insert with check (auth.uid() = user_id);

create policy "away_replies_owner_update" on public.away_prepared_replies
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "away_replies_owner_delete" on public.away_prepared_replies
  for delete using (auth.uid() = user_id);

create policy "away_events_owner_select" on public.away_events
  for select using (auth.uid() = user_id);

create policy "away_events_owner_insert" on public.away_events
  for insert with check (auth.uid() = user_id);

-- No update or delete policy on away_events: append-only by construction.

-- --- Privileges --------------------------------------------------------------
--
-- 0006 granted on the tables that existed then; grants are not retroactive, so
-- new tables need their own. Same rule: authenticated only, never anon, and let
-- RLS do the row scoping. The activity log gets no update or delete privilege,
-- matching its absence of an update or delete policy.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update, delete on public.away_settings to authenticated;
    grant select, insert, update, delete on public.away_contact_permissions to authenticated;
    grant select, insert, update, delete on public.away_prepared_replies to authenticated;
    grant select, insert on public.away_events to authenticated;

    revoke all on public.away_settings from anon;
    revoke all on public.away_contact_permissions from anon;
    revoke all on public.away_prepared_replies from anon;
    revoke all on public.away_events from anon;
  end if;
end;
$$;
