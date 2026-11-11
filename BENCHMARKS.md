# Benchmarks & testing report

Measured on 2026-11-06. **Everything below was run, not estimated.** Where a
number could not be obtained, this file says so instead of inventing one.

## Scope, stated plainly

The phase gate was closed first: `npm run verify` (typecheck + lint + 434 tests +
build) and `npm run db:verify` (22 schema tests on real PostgreSQL) both passed
before any measurement was taken. Benchmarking a codebase that is not finished
measures the wrong thing.

| What is measured | What is **not** measured |
| --- | --- |
| Parser, understanding, style, prompt building — real exported functions | Any generative AI provider call — no API key exists, so every provider path in the suite is a mocked transport |
| HTTP routes served by `next start` from the production build | Vercel's serverless runtime; these are this sandbox's numbers |
| Memory scaling of the parser | Database/PostgREST latency; this sandbox cannot reach Supabase (egress allow-list) |
| — | Real user traffic, React render/hydration, mobile devices |

Environment: Node v22.22.3, linux x64, **2 vCPUs**, shared sandbox. Re-run with
`npx tsx --tsconfig scripts/tsconfig.json scripts/bench.ts`.

---

## 1. The optimisation that came out of this work

`extractTopics` and `extractPlans` compiled a brand-new `RegExp` inside the
per-message loop:

```ts
for (const rule of TOPIC_RULES) {
  const hit = rule.keywords.some((keyword) =>
    new RegExp(`(^|\\W)${escapeRegex(keyword)}(\\W|$)`, "i").test(lower));
```

The pattern for a given keyword never changes, so this recompiled the same
expressions thousands of times. Fixed in `src/lib/intelligence/keyword-matcher.ts`:
each rule's keywords are compiled **once, at module load**, into a single
alternation — `(^|\W)(?:work|job|office|…)(\W|$)`.

`extractTopics` passes indices of messages that were already lowercased, so the
text is unchanged; only the compiled-pattern lifetime changed.

### Before / after on identical input

Same machine, same generated corpus, same trailing newline, 5 runs after warmup:

| Messages | Before (median) | After (median) | Change |
| --- | --- | --- | --- |
| 1,000 | 58.9 ms | 12.5 ms | **4.7× faster** |
| 10,000 | 665 ms | 207 ms | **3.2× faster** |
| 50,000 | 5,231 ms | 3,014 ms | **1.7× faster** |

A second pass merged each rule's keyword list into one alternation pattern:

| Messages | Before | After (final) | Change |
| --- | --- | --- | --- |
| 1,000 | 58.9 ms | 6.7 ms | **8.7× faster** |
| 10,000 | 665 ms | 158 ms | **4.2× faster** |
| 50,000 | 5,231 ms | 2,586 ms | **2.0× faster** |

Correctness was not assumed. All 434 pre-existing tests pass unchanged, and
`tests/intelligence/keyword-matcher.test.ts` adds 6 tests asserting the new
matcher matches exactly what the old one did — including word boundaries
(`hardworking` must not match `work`), case-insensitivity, literal treatment of
regex metacharacters, and freedom from `lastIndex` state.

**A caveat worth recording:** my first attempt to measure this produced garbage.
The harness mapped a nonexistent `m.direction` field, so every message was typed
`system`, `meaningful()` filtered them all out, and the "2 ms" result was the
cost of measuring an empty array. It looked like a 50× speedup. It was a broken
benchmark. The table above comes from the corrected harness, and the before
numbers were re-taken by reverting the source with `git checkout` and re-running.

## 2. Parsing (`parseWhatsAppExport`)

| Messages | Export size | Median | p95 | Throughput |
| --- | --- | --- | --- | --- |
| 1,000 | 0.1 MB | 1.1 ms | 1.3 ms | ~900,000 msg/s |
| 10,000 | 0.6 MB | 17.3 ms | 22.4 ms | ~577,000 msg/s |
| 50,000 | 3.0 MB | 104 ms | 133 ms | ~483,000 msg/s |

Roughly linear, ~2.7 µs per message. A 50,000-message export parses in about a
tenth of a second.

## 3. Memory scaling (parser)

Run with `--expose-gc`, heap measured before and after each parse:

| Messages | Input | Heap delta | Peak RSS | Time |
| --- | --- | --- | --- | --- |
| 10,000 | 0.8 MB | +4.2 MB | 79 MB | 34 ms |
| 50,000 | 4.0 MB | +22.7 MB | 123 MB | 106 ms |
| 100,000 | 8.0 MB | +31.9 MB | 144 MB | 186 ms |

Linear and unremarkable: ~10× the input size in heap, which is expected for a
message object per row. **The default cap is 200,000 messages**
(`DEFAULT_MAX_MESSAGES`), so an 8 MB export at 100,000 messages is comfortably
inside it, and peak RSS stays around 144 MB on a 2-vCPU box.

## 4. Style analysis (`analyseConversationStyle`)

| Messages | Median | p95 |
| --- | --- | --- |
| 1,000 | 8.2 ms | 8.3 ms |
| 10,000 | 58.8 ms | 62.3 ms |
| 50,000 | 280 ms | 289 ms |

## 5. Reply prompt construction (per request)

| Operation | Median | p95 |
| --- | --- | --- |
| `buildReplySystemPrompt` | < 0.01 ms | < 0.01 ms |
| `buildReplyUserPrompt` (50 memories, 20 recent messages) | 0.01 ms | 0.02 ms |

Negligible. Total request cost is dominated by the model call, not prompt
assembly — and that call is the one thing this environment cannot measure.

## 6. HTTP under concurrency

`next start` on the production build, N concurrent requests per route, all
responses `200`:

| Route | Concurrency | Wall | Req/s |
| --- | --- | --- | --- |
| `/` | 10 / 50 | 106 ms / 332 ms | 95 / 151 |
| `/login` | 10 / 50 | 114 ms / 310 ms | 88 / 161 |
| `/signup` | 10 / 50 | 100 ms / 250 ms | 100 / 200 |
| `/integrations` | 10 / 50 | 55 ms / 245 ms | 183 / 204 |

240 requests total, every one `200`, ~1.5 s aggregate. Throughput rises with
concurrency rather than collapsing, so the server keeps accepting work under
load. These pages are dynamic and do not touch the database in this
configuration, so this measures the Next.js request path, not a real user
session.

## 7. Client bundle

From the production build, **uncompressed** on disk:

| Chunk | Size |
| --- | --- |
| largest | 360 KB |
| second | 224 KB |
| third | 168 KB |
| total `static/chunks` | 1.1 MB |

This is the honest raw figure. It is *not* gzipped/brotli transfer size, and no
Lighthouse or Core Web Vitals run was performed, so no "performance score" is
claimed.

## 8. What would still need measuring

| Gap | Why it is open |
| --- | --- |
| Real model call latency | No API key has ever existed in this environment; every provider test uses a mocked transport |
| Database latency | Sandbox egress blocks Supabase; RLS correctness was verified a different way (through the management API) |
| Vercel cold starts / serverless timing | Nothing is deployed yet |
| Real device / mobile rendering | Not tested on a handset |
| Lighthouse / Core Web Vitals | Not run; would need a browser harness |
| Large-file upload path (Storage) | Not exercised end to end |
