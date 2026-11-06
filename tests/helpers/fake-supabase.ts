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

  limit(count: number) {
    this.limitCount = count;
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

      for (const row of inserted) {
        rows.push({ created_at: new Date().toISOString(), ...row });
        this.state.insertCount[this.table] = (this.state.insertCount[this.table] ?? 0) + 1;
      }

      return { data: this.returning ? inserted : [], error: null };
    }

    if (this.updateValues) {
      const updated: Row[] = [];
      for (const row of rows) {
        if (!matches(row, this.filters)) continue;
        Object.assign(row, this.updateValues);
        updated.push(row);
      }
      return { data: updated, error: null };
    }

    if (this.deletion) {
      const kept = rows.filter((row) => !matches(row, this.filters));
      const removed = rows.length - kept.length;
      this.state.tables[this.table] = kept;
      this.state.deleteCount[this.table] = (this.state.deleteCount[this.table] ?? 0) + removed;
      return { data: [], error: null };
    }

    let found = rows.filter((row) => matches(row, this.filters));
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
