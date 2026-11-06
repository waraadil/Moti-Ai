-- ===========================================================================
-- 0002  Identity: user profiles and contacts
-- ===========================================================================
-- A "profile" row mirrors auth.users 1:1 (auth owns credentials, we own app
-- data). A "contact" is someone the user talked to. Contact identity is
-- deliberately conservative: no automatic merging of lookalike people.
-- ===========================================================================

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  timezone text not null default 'UTC',
  onboarded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint profiles_email_looks_valid
    check (email is null or position('@' in email) > 1),
  constraint profiles_display_name_len
    check (display_name is null or char_length(display_name) between 1 and 120)
);

comment on table public.profiles is
  'Application-level user record, one row per Supabase auth user.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Mirror new auth users into public.profiles. Runs as definer so the insert
-- succeeds during signup, before the user has any session.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), '')
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- --------------------------------------------------------------------------
-- Contacts
-- --------------------------------------------------------------------------

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  display_name text not null,
  relationship_kind public.relationship_kind not null default 'unknown',
  -- Raw identifiers from the export. Kept as-is: normalising them is the
  -- importer's job and a wrong normalisation merges two different people.
  whatsapp_jid text,
  phone_number text,
  notes text,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint contacts_display_name_not_blank
    check (char_length(btrim(display_name)) between 1 and 160),
  constraint contacts_phone_shape
    check (phone_number is null or phone_number ~ '^\+?[0-9]{6,20}$'),
  constraint contacts_notes_len
    check (notes is null or char_length(notes) <= 4000)
);

comment on table public.contacts is
  'A person the Moti user has conversations with. Contacts are never merged automatically.';

-- One contact per WhatsApp identity per user, but only when the identity is
-- actually known. Partial indexes avoid treating NULLs as duplicates.
create unique index contacts_user_whatsapp_jid_key
  on public.contacts (user_id, whatsapp_jid)
  where whatsapp_jid is not null;

create unique index contacts_user_phone_key
  on public.contacts (user_id, phone_number)
  where phone_number is not null;

-- Deliberately NOT unique on display_name: two different people can share a name.

create index contacts_user_id_idx on public.contacts (user_id);
create index contacts_user_archived_idx on public.contacts (user_id, is_archived);

create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

-- --------------------------------------------------------------------------
-- Contact aliases
-- --------------------------------------------------------------------------
-- Exports render the same person differently over the years ("Mum", "Mom ❤️",
-- "+44 7700 900123"). Aliases are recorded separately and flagged, never
-- applied as an identity merge on their own.

create table public.contact_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  alias text not null,
  source text not null default 'import',
  is_confirmed boolean not null default false,
  created_at timestamptz not null default now(),

  constraint contact_aliases_alias_not_blank
    check (char_length(btrim(alias)) between 1 and 160)
);

comment on table public.contact_aliases is
  'Alternative names observed for a contact. Aliases require user confirmation before affecting identity.';

create unique index contact_aliases_unique_label
  on public.contact_aliases (contact_id, lower(alias));

create index contact_aliases_user_id_idx on public.contact_aliases (user_id);
