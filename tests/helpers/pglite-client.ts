/**
 * A tiny Supabase-compatible query builder backed by PGlite.
 *
 * Purpose: run the *real* analysis pipeline against the *real* schema (real
 * constraints, indexes, triggers, RLS) in CI, without a hosted project.
 *
 * Only the subset of the client API the analysis code uses is implemented, and
 * anything unsupported throws loudly rather than silently doing nothing.
 */

import type { PGlite } from "@electric-sql/pglite";
import type { ServerSupabaseClient } from "@/lib/supabase/server";

type Row = Record<string, unknown>;
type FilterOp = "eq" | "in" | "lt" | "is" | "neq";

type Filter = {
  column: string;
  op: FilterOp;
  value: unknown;
};

/** Maps a JS/snake_case column name onto its SQL column for ORDER BY etc. */
function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

class PGliteQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Filter[] = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private limitCount: number | null = null;
  private mode: "select" | "insert" | "update" | "upsert" = "select";
  private payload: Row | Row[] | null = null;
  private updateValues: Row | null = null;
  private selectColumns = "*";
  private conflictTarget: string | null = null;

  constructor(
    private readonly db: PGlite,
    private readonly table: string,
  ) {}

  select(columns = "*") {
    this.selectColumns = columns;
    return this;
  }

  insert(values: Row | Row[]) {
    this.mode = "insert";
    this.payload = values;
    return this;
  }

  update(values: Row) {
    this.mode = "update";
    this.updateValues = values;
    return this;
  }

  upsert(values: Row | Row[], options?: { onConflict?: string }) {
    this.mode = "upsert";
    this.payload = values;
    this.conflictTarget = options?.onConflict ?? null;
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, op: "eq", value });
    return this;
  }

  neq(column: string, value: unknown) {
    this.filters.push({ column, op: "neq", value });
    return this;
  }

  in(column: string, values: unknown[]) {
    this.filters.push({ column, op: "in", value: values });
    return this;
  }

  lt(column: string, value: unknown) {
    this.filters.push({ column, op: "lt", value });
    return this;
  }

  is(column: string, value: null) {
    this.filters.push({ column, op: "is", value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orders.push({ column, ascending: options?.ascending ?? true });
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  async maybeSingle() {
    const result = await this.run();
    if (result.error) return { data: null, error: result.error };
    const rows = result.data as Row[];
    return { data: rows[0] ?? null, error: null };
  }

  async single() {
    const { data, error } = await this.maybeSingle();
    if (error) return { data: null, error };
    if (!data) return { data: null, error: { message: "no rows returned", code: "PGRST116" } };
    return { data, error: null };
  }

  then<TResult1, TResult2 = never>(
    onfulfilled?:
      ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }

  /** Builds the WHERE clause from the accumulated filters. */
  private where(): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    for (const filter of this.filters) {
      const column = quoteIdent(filter.column);
      switch (filter.op) {
        case "eq":
          params.push(filter.value);
          clauses.push(`${column} = $${params.length}`);
          break;
        case "neq":
          params.push(filter.value);
          clauses.push(`${column} <> $${params.length}`);
          break;
        case "in": {
          const values = filter.value as unknown[];
          if (values.length === 0) {
            clauses.push("false");
            break;
          }
          params.push(values);
          clauses.push(`${column} = any($${params.length})`);
          break;
        }
        case "lt":
          params.push(filter.value);
          clauses.push(`${column} < $${params.length}`);
          break;
        case "is":
          clauses.push(`${column} is null`);
          break;
        default:
          throw new Error(`Unsupported filter op: ${String(filter.op)}`);
      }
    }

    return {
      sql: clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "",
      params,
    };
  }

  private returning(): string {
    return this.selectColumns === "*" ? "*" : this.selectColumns;
  }

  private async run(): Promise<{ data: unknown; error: unknown }> {
    const table = `public.${quoteIdent(this.table)}`;

    try {
      if (this.mode === "insert" || this.mode === "upsert") {
        const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
        if (rows.length === 0) return { data: [], error: null };

        const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
        if (columns.length === 0) return { data: [], error: null };

        const params: unknown[] = [];
        const values = rows
          .map((row) => {
            const placeholders = columns.map((column) => {
              params.push(row[column] ?? null);
              return `$${params.length}`;
            });
            return `(${placeholders.join(", ")})`;
          })
          .join(", ");

        const conflict =
          this.mode === "upsert" && this.conflictTarget
            ? ` on conflict (${this.conflictTarget
                .split(",")
                .map((part) => quoteIdent(part.trim()))
                .join(", ")}) do update set ${columns
                .filter((column) => column !== "id")
                .map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`)
                .join(", ")}`
            : this.mode === "upsert"
              ? " on conflict do nothing"
              : "";

        const sql = `insert into ${table} (${columns
          .map((column) => quoteIdent(column))
          .join(", ")}) values ${values}${conflict} returning ${this.returning()}`;

        const result = await this.db.query<Row>(sql, params);
        return { data: result.rows, error: null };
      }

      if (this.mode === "update") {
        const values = this.updateValues ?? {};
        const columns = Object.keys(values);
        if (columns.length === 0) return { data: [], error: null };

        const params: unknown[] = [];
        const assignments = columns
          .map((column) => {
            params.push(values[column] ?? null);
            return `${quoteIdent(column)} = $${params.length}`;
          })
          .join(", ");

        const where = this.where();
        const shifted = where.sql.replace(
          /\$(\d+)/g,
          (_, index: string) => `$${Number(index) + params.length}`,
        );

        const sql = `update ${table} set ${assignments}${shifted} returning ${this.returning()}`;
        const result = await this.db.query<Row>(sql, [...params, ...where.params]);
        return { data: result.rows, error: null };
      }

      const where = this.where();
      const order =
        this.orders.length > 0
          ? ` order by ${this.orders
              .map((entry) => `${quoteIdent(entry.column)} ${entry.ascending ? "asc" : "desc"}`)
              .join(", ")}`
          : "";
      const limit = this.limitCount !== null ? ` limit ${this.limitCount}` : "";

      const sql = `select ${this.returning()} from ${table}${where.sql}${order}${limit}`;
      const result = await this.db.query<Row>(sql, where.params);
      return { data: result.rows, error: null };
    } catch (error) {
      return { data: null, error };
    }
  }
}

/**
 * Wraps a PGlite instance in the shape the analysis code expects. Cast at the
 * boundary: the builder implements the subset used, not the whole client.
 */
export function createPGliteClient(db: PGlite): ServerSupabaseClient {
  return {
    from: (table: string) => new PGliteQuery(db, table),
  } as unknown as ServerSupabaseClient;
}
