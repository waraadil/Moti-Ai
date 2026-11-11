/**
 * Minimal in-memory stand-in for the parts of the Supabase client the import
 * pipeline touches.
 *
 * It is intentionally not a general-purpose mock: it implements exactly the
 * query builder shapes used by `src/server/imports` so the pipeline's real
 * control flow (dedupe first, cleanup on rejection, status transitions) is what
 * gets exercised, without needing a live project.
 */

type Row = Record<string, unknown>;

/** Mirrors the Json type from database.types; the fake avoids importing src. */
type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type QueryResult<T> = { data: T; error: null | { message: string; code?: string } };

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([column, value]) => row[column] === value);
}

class TableQuery {
  private filters: Array<[string, unknown]> = [];
  private insertion: Row | Row[] | null = null;
  private updateValues: Row | null = null;
  private deletion = false;
  private returning = false;
  private limitCount: number | null = null;
  private rangeSpec: { from: number; to: number } | null = null;
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private nullFilters: Array<[string, "null" | "not-null"]> = [];
  private ltFilters: Array<[string, unknown]> = [];
  private inFilters: Array<[string, unknown[]]> = [];
  private upsertMode: { conflict: string } | null = null;

  constructor(
    private readonly table: string,
    private readonly state: FakeState,
  ) {}

  select() {
    return this;
  }

  insert(values: Row | Row[]) {
    this.insertion = values;
    this.returning = true;
    return this;
  }

  update(values: Row) {
    this.updateValues = values;
    return this;
  }

  delete() {
    this.deletion = true;
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }

  in(column: string, values: unknown[]) {
    this.inFilters.push([column, values]);
    return this;
  }

  lt(column: string, value: unknown) {
    this.ltFilters.push([column, value]);
    return this;
  }

  is(column: string, value: null) {
    this.nullFilters.push([column, value === null ? "null" : "not-null"]);
    return this;
  }

  /** PostgREST `.not(column, operator, value)` — only the null check is used. */
  not(column: string, operator: string, value: unknown) {
    if (operator !== "is") {
      throw new Error(`fake-supabase: .not() with operator "${operator}" is not implemented`);
    }
    if (value !== null) {
      throw new Error("fake-supabase: .not() only supports 'is null'");
    }
    this.nullFilters.push([column, "not-null"]);
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orders.push({ column, ascending: options?.ascending ?? true });
    return this;
  }

  upsert(values: Row | Row[], options?: { onConflict?: string }) {
    this.insertion = values;
    this.returning = true;
    this.upsertMode = { conflict: options?.onConflict ?? "id" };
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  /** PostgREST `range(from, to)` — inclusive of both bounds. */
  range(from: number, to: number) {
    this.rangeSpec = { from, to };
    return this;
  }

  async maybeSingle() {
    const result = await this.execute();
    const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
    return { data: rows[0] ?? null, error: result.error };
  }

  async single() {
    const { data, error } = await this.maybeSingle();
    if (!data) return { data: null, error: error ?? { message: "no rows returned" } };
    return { data, error };
  }

  then<TResult1, TResult2 = never>(
    onfulfilled?: ((value: QueryResult<Row[]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  /**
   * Applies every filter the query built. Reads, updates and deletes all go
   * through here so a filter can never be silently ignored (which previously
   * let a scoped update touch rows it should not have).
   */
  private applyFilters(rows: Row[]): Row[] {
    let found = rows.filter((row) => matches(row, this.filters));

    for (const [column, mode] of this.nullFilters) {
      found = found.filter((row) =>
        mode === "null" ? row[column] === null || row[column] === undefined : row[column] != null,
      );
    }
    for (const [column, values] of this.inFilters) {
      found = found.filter((row) => values.includes(row[column]));
    }
    for (const [column, value] of this.ltFilters) {
      found = found.filter((row) => {
        const left = row[column];
        if (typeof left === "number" && typeof value === "number") return left < value;
        if (typeof left === "string" && typeof value === "string") {
          return Date.parse(left) < Date.parse(value);
        }
        return false;
      });
    }
    return found;
  }

  private async execute(): Promise<QueryResult<Row[]>> {
    const rows = this.state.tables[this.table] ?? (this.state.tables[this.table] = []);

    if (this.insertion !== null) {
      const inserted = Array.isArray(this.insertion) ? this.insertion : [this.insertion];

      // Emulate the unique index on (user_id, checksum) for chat_imports.
      if (this.table === "chat_imports") {
        for (const candidate of inserted) {
          const clash = rows.some(
            (row) =>
              row.user_id === candidate.user_id &&
              candidate.checksum !== undefined &&
              candidate.checksum !== null &&
              row.checksum === candidate.checksum,
          );
          if (clash) {
            return { data: [], error: { message: "duplicate key value", code: "23505" } };
          }
        }
      }

      const stored: Row[] = [];

      for (const row of inserted) {
        if (this.upsertMode) {
          const keys = this.upsertMode.conflict.split(",").map((key) => key.trim());
          const existingIndex = rows.findIndex((candidate) =>
            keys.every((key) => candidate[key] === row[key]),
          );
          if (existingIndex >= 0) {
            rows[existingIndex] = { ...rows[existingIndex], ...row };
            stored.push(rows[existingIndex] as Row);
            continue;
          }
        }
        // Postgres applies column defaults; mirror that so callers get the id back.
        const persisted: Row = {
          ...COLUMN_DEFAULTS[this.table],
          created_at: new Date().toISOString(),
          ...row,
          id: row.id ?? nextId(this.table),
        };
        rows.push(persisted);
        stored.push(persisted);
        this.state.insertCount[this.table] = (this.state.insertCount[this.table] ?? 0) + 1;
      }

      // `.insert(...).select(...)` returns the persisted rows, including defaults.
      return { data: this.returning ? stored : [], error: null };
    }

    if (this.updateValues) {
      const updated: Row[] = [];
      for (const row of this.applyFilters(rows)) {
        Object.assign(row, this.updateValues);
        // Returned rows are copies: a caller that reads before updating must not
        // see its earlier snapshot change underneath it.
        updated.push({ ...row });
      }
      return { data: updated, error: null };
    }

    if (this.deletion) {
      const doomed = new Set(this.applyFilters(rows));
      const kept = rows.filter((row) => !doomed.has(row));
      const removed = rows.length - kept.length;
      this.state.tables[this.table] = kept;
      this.state.deleteCount[this.table] = (this.state.deleteCount[this.table] ?? 0) + removed;
      return { data: [], error: null };
    }

    let found = this.applyFilters(rows);

    for (const { column, ascending } of [...this.orders].reverse()) {
      found = [...found].sort((a, b) => {
        const left = a[column] as string | number;
        const right = b[column] as string | number;
        if (left === right) return 0;
        return (left < right ? -1 : 1) * (ascending ? 1 : -1);
      });
    }

    if (this.rangeSpec) {
      found = found.slice(this.rangeSpec.from, this.rangeSpec.to + 1);
    }
    if (this.limitCount !== null) found = found.slice(0, this.limitCount);
    /*
     * Copies, not references. PostgREST returns values over the wire, so caller
     * and table never share an object. Sharing them let an update mutate a
     * value the caller had already read, which hid a before/after comparison.
     */
    return { data: found.map((row) => ({ ...row })), error: null };
  }
}

export type FakeState = {
  // Reassignable: the fake RPC snapshots and restores this to emulate rollback.
  tables: Record<string, Row[]>;
  objects: Map<string, Uint8Array>;
  uploads: string[];
  removals: string[];
  downloads: string[];
  insertCount: Record<string, number>;
  deleteCount: Record<string, number>;
  /** When set, the next storage upload fails with this message. */
  failNextUpload?: string;
  /** When set, downloads for these paths fail. */
  failDownloadPaths: Set<string>;
  failRemovals: boolean;
  /**
   * Makes the fake `rpc` fail part-way through a deletion, after some tables
   * have been touched. Used to prove the whole operation rolls back rather than
   * leaving a half-deleted account.
   */
  failRpcAtTable: string | null;
  /** Forces `rpc` to fail before any work, as a connection failure would. */
  failRpcEntirely: boolean;
  /** Stands in for auth.uid(); the deletion RPCs read identity from here. */
  currentUserId: string | null;
};

export type FakeSupabase = {
  state: FakeState;
  from: (table: string) => TableQuery;
  rpc: (name: string, args?: Record<string, unknown>) => Promise<{ data: Json | null; error: { message: string } | null }>;
  storage: {
    from: (bucket: string) => {
      upload: (
        path: string,
        body: Uint8Array,
        options?: { contentType?: string; upsert?: boolean },
      ) => Promise<{ error: null | { message: string } }>;
      remove: (paths: string[]) => Promise<{ error: null | { message: string } }>;
      download: (path: string) => Promise<{
        data: { text: () => Promise<string> } | null;
        error: null | { message: string };
      }>;
      createSignedUrl: (
        path: string,
        expiresIn: number,
      ) => Promise<{ data: { signedUrl: string }; error: null }>;
    };
  };
};

/**
 * Column defaults that live in the migrations.
 *
 * The fake must apply these, otherwise a repository that (correctly) relies on
 * the database default reads back `undefined` in tests and the bug only appears
 * against real Postgres.
 */
const COLUMN_DEFAULTS: Record<string, Record<string, unknown>> = {
  memories: { status: "active", is_user_confirmed: false, is_sensitive: false },
  reply_drafts: { status: "draft", used_memory_ids: [] },
  analysis_runs: { status: "pending", attempts: 0, input_messages: 0 },
  // Away Mode defaults mirror the migration, so a test that forgets to set a
  // field behaves like production rather than like an unconstrained table.
  away_settings: {
    status: "off",
    starts_at: null,
    ends_at: null,
    away_message: null,
    default_permission: "draft_only",
  },
  away_contact_permissions: { permission: "draft_only" },
  away_prepared_replies: { state: "pending", decided_at: null },
};

let idCounter = 0;

/** Mimics `gen_random_uuid()` well enough for assertions and joins. */
function nextId(table: string): string {
  idCounter += 1;
  return `${table}-${String(idCounter).padStart(6, "0")}`;
}

export function createFakeSupabase(): FakeSupabase {
  const state: FakeState = {
    tables: {},
    objects: new Map(),
    uploads: [],
    removals: [],
    downloads: [],
    insertCount: {},
    deleteCount: {},
    failDownloadPaths: new Set(),
    failRemovals: false,
    failRpcAtTable: null,
    failRpcEntirely: false,
    currentUserId: null,
  };

  return {
    state,

    /**
     * Emulates the deletion RPCs from migration 0011.
     *
     * These are the parts of the real behaviour that matter for correctness:
     *
     *   - the whole thing runs on a snapshot and is committed only at the end,
     *     so a failure anywhere leaves the database exactly as it was;
     *   - the user comes from `state.currentUserId` (standing in for auth.uid()),
     *     never from an argument;
     *   - storage paths are queued as jobs rather than deleted here.
     *
     * Other RPCs are rejected loudly rather than silently returning nothing,
     * because a test that passes against a no-op is worse than a failing one.
     */
    async rpc(name: string, args: Record<string, unknown> = {}) {
      if (state.failRpcEntirely) {
        return { data: null, error: { message: "connection reset" } };
      }

      if (name === "record_cleanup_failure") {
        const jobId = String(args.p_job_id ?? "");
        const rows = state.tables.data_cleanup_jobs ?? [];
        const job = rows.find((row) => row.id === jobId);
        if (!job) return { data: null, error: { message: "job not found" } };
        job.attempts = Number(job.attempts ?? 0) + 1;
        job.last_error = String(args.p_error ?? "");
        job.last_attempt_at = new Date().toISOString();
        return { data: null, error: null };
      }

      if (name !== "delete_contact_data" && name !== "delete_all_user_data") {
        return { data: null, error: { message: `fake-supabase: rpc "${name}" not implemented` } };
      }

      const userId = state.currentUserId;
      if (!userId) {
        return { data: null, error: { message: "delete: not authenticated" } };
      }

      const scoped = name === "delete_contact_data";
      const contactId = scoped ? String(args.p_contact_id ?? "") : null;
      const anonymise = name === "delete_all_user_data" && args.p_anonymise !== false;

      // Take a snapshot so a mid-way failure can be rolled back.
      const snapshot = structuredClone(state.tables);

      const rollback = () => {
        state.tables = snapshot;
      };

      if (scoped) {
        const owned = (state.tables.contacts ?? []).some(
          (row) => row.id === contactId && row.user_id === userId,
        );
        if (!owned) {
          return { data: null, error: { message: "contact not found or not yours" } };
        }
      }

      // Queue storage objects while their rows still exist.
      state.tables.data_cleanup_jobs = state.tables.data_cleanup_jobs ?? [];
      let queued = 0;
      for (const row of state.tables.chat_imports ?? []) {
        if (row.user_id !== userId) continue;
        if (scoped && row.contact_id !== contactId) continue;
        if (!row.storage_path) continue;
        const exists = state.tables.data_cleanup_jobs.some(
          (job) => job.object_path === row.storage_path,
        );
        if (exists) continue;
        state.tables.data_cleanup_jobs.push({
          id: nextId("data_cleanup_jobs"),
          user_id: userId,
          kind: "chat_import_object",
          bucket: "chat-imports",
          object_path: row.storage_path,
          attempts: 0,
          last_error: null,
          last_attempt_at: null,
          created_at: new Date().toISOString(),
        });
        queued += 1;
      }

      const deleted: Record<string, number> = {};

      const purge = (table: string): boolean => {
        if (state.failRpcAtTable === table) return false;
        const rows = state.tables[table] ?? [];

        /*
         * memory_evidence has no contact_id: it is scoped through its parent
         * memory. The fake mirrors that, so a test cannot pass on a shape the
         * real database does not have.
         */
        if (table === "memory_evidence") {
          const memoryIds = new Set(
            (state.tables.memories ?? [])
              .filter((row) => row.user_id === userId && (!scoped || row.contact_id === contactId))
              .map((row) => row.id),
          );
          const keptEvidence = rows.filter(
            (row) => row.user_id !== userId || !memoryIds.has(row.memory_id),
          );
          const removedEvidence = rows.length - keptEvidence.length;
          state.tables[table] = keptEvidence;
          if (removedEvidence > 0) deleted[table] = removedEvidence;
          return true;
        }
        const kept = rows.filter((row) => {
          if (row.user_id !== userId) return true;
          if (scoped && row.contact_id !== contactId) return true;
          return false;
        });
        const removed = rows.length - kept.length;
        state.tables[table] = kept;
        if (removed > 0) deleted[table] = removed;
        return true;
      };

      const order = [
        "away_prepared_replies",
        "away_events",
        "away_contact_permissions",
        "away_settings",
        "reply_drafts",
        "conversation_snapshots",
        "analysis_runs",
        "analysis_versions",
        "memory_evidence",
        "memories",
        "relationship_contexts",
        "communication_profiles",
        "contact_aliases",
        "messages",
        "chat_imports",
      ];

      for (const table of order) {
        if (!purge(table)) {
          rollback();
          return { data: null, error: { message: `simulated failure deleting from ${table}` } };
        }
      }

      // Contacts are keyed by id, not contact_id.
      if (state.failRpcAtTable === "contacts") {
        rollback();
        return { data: null, error: { message: "simulated failure deleting contacts" } };
      }
      {
        const rows = state.tables.contacts ?? [];
        const kept = rows.filter(
          (row) =>
            row.user_id !== userId || (scoped && row.id !== contactId),
        );
        const removed = rows.length - kept.length;
        state.tables.contacts = kept;
        if (removed > 0) deleted.contacts = removed;
      }

      if (anonymise) {
        const profile = (state.tables.profiles ?? []).find((row) => row.id === userId);
        if (profile) {
          profile.email = null;
          profile.display_name = "Deleted account";
          profile.timezone = "UTC";
          deleted.profile_anonymised = 1;
        }
      }

      const pending = state.tables.data_cleanup_jobs.filter((job) => job.user_id === userId);

      return {
        data: {
          deleted,
          purge_contact: contactId,
          queued_files: queued,
          complete: pending.length === 0,
        },
        error: null,
      };
    },
    from: (table: string) => new TableQuery(table, state),
    storage: {
      from: () => ({
        async upload(path, body) {
          if (state.failNextUpload) {
            const message = state.failNextUpload;
            state.failNextUpload = undefined;
            return { error: { message } };
          }
          state.objects.set(path, body);
          state.uploads.push(path);
          return { error: null };
        },
        async remove(paths) {
          // Lets a test prove that a failed file removal does not proceed to
          // delete database rows, which would strand an unreachable copy.
          if (state.failRemovals) {
            return { error: { message: "storage unavailable" } };
          }
          for (const path of paths) {
            state.objects.delete(path);
            state.removals.push(path);
          }
          return { error: null };
        },
        async download(path) {
          state.downloads.push(path);
          if (state.failDownloadPaths.has(path)) {
            return { data: null, error: { message: "object not found" } };
          }
          const bytes = state.objects.get(path);
          if (!bytes) return { data: null, error: { message: "object not found" } };
          const text = new TextDecoder().decode(bytes);
          return { data: { text: async () => text }, error: null };
        },
        async createSignedUrl(path, expiresIn) {
          return {
            data: { signedUrl: `https://example.test/${path}?exp=${expiresIn}` },
            error: null,
          };
        },
      }),
    },
  };
}

/** Cast helper: the fake implements the surface the pipeline uses. */
export function asServerClient(fake: FakeSupabase): never {
  return fake as unknown as never;
}
