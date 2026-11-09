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
        updated.push(row);
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
    return { data: found, error: null };
  }
}

export type FakeState = {
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
};

export type FakeSupabase = {
  state: FakeState;
  from: (table: string) => TableQuery;
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
  };

  return {
    state,
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
