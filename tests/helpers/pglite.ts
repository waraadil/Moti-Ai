import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

/**
 * Minimal stand-ins for the parts of a Supabase project that migrations touch:
 * the auth schema, the storage schema and the anon/authenticated roles.
 *
 * `auth.uid()` reads a session GUC so tests can act as a specific user, which
 * is exactly how Supabase resolves the JWT subject.
 */
const SUPABASE_SHIM = `
  create schema if not exists auth;

  create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    created_at timestamptz default now()
  );

  create or replace function auth.uid()
  returns uuid
  language sql
  stable
  as $$
    select nullif(current_setting('test.uid', true), '')::uuid;
  $$;

  create schema if not exists storage;

  create table if not exists storage.buckets (
    id text primary key,
    name text,
    public boolean default false,
    file_size_limit bigint,
    allowed_mime_types text[],
    created_at timestamptz default now()
  );

  create table if not exists storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text,
    name text,
    owner uuid,
    created_at timestamptz default now()
  );

  create or replace function storage.foldername(name text)
  returns text[]
  language sql
  immutable
  as $$
    select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 1)];
  $$;

  do $$
  begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated;
    end if;
  end;
  $$;

  -- Supabase grants these by default; the RLS tests need them to call auth.uid().
  grant usage on schema auth to authenticated, anon;
  grant usage on schema storage to authenticated, anon;
  grant select on storage.objects, storage.buckets to authenticated;
`;

export type TestDatabase = {
  db: PGlite;
  appliedMigrations: string[];
  close: () => Promise<void>;
};

/**
 * Boots a throwaway in-memory PostgreSQL, applies the Supabase shim, then runs
 * every migration in filename order. Throws on the first failure with the file
 * name attached, so a broken migration is obvious.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const db = await PGlite.create({
    extensions: { pgcrypto, pg_trgm },
  });

  await db.exec(SUPABASE_SHIM);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const appliedMigrations: string[] = [];

  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    try {
      await db.exec(sql);
      appliedMigrations.push(file);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${file} failed: ${reason}`);
    }
  }

  return {
    db,
    appliedMigrations,
    close: () => db.close(),
  };
}

/** Creates an auth user (which fires the profile trigger) and returns its id. */
export async function createUser(db: PGlite, email: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id",
    [email, JSON.stringify({ display_name: email.split("@")[0] })],
  );
  const row = result.rows[0];
  if (!row) throw new Error("failed to create auth user");
  return row.id;
}

/**
 * Runs `fn` as the given user through the `authenticated` role, so Row Level
 * Security is genuinely enforced rather than bypassed by the table owner.
 */
export async function asUser<T>(db: PGlite, userId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role authenticated; select set_config('test.uid', '${userId}', false);`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('test.uid', '', false);`);
  }
}
