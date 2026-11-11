/**
 * Benchmark harness for Moti AI's platform-independent intelligence engine.
 *
 * READ THIS BEFORE QUOTING NUMBERS
 * --------------------------------
 * These measurements run the REAL exported code — no mocks, no fixtures
 * pretending to be work. But they measure one process on one machine:
 *
 *   - Node on a shared sandbox CPU, not Vercel's serverless runtime.
 *   - No network, no database, no React rendering.
 *   - The generative provider is NOT benchmarked, because no API key exists
 *     and every provider call in the test suite is a mocked transport.
 *
 * So these numbers say "how fast is the pure computation", and nothing about
 * end-to-end request latency. Anything else would be an invented figure.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.json scripts/bench.ts
 */

import { parseWhatsAppExport } from "../src/lib/conversations/parser";
import { understandConversation } from "../src/lib/intelligence/understanding";
import { analyseConversationStyle } from "../src/lib/intelligence/style";
import { buildReplyUserPrompt, buildReplySystemPrompt } from "../src/lib/intelligence/reply";
import type { AnalysisMessage } from "../src/lib/intelligence/types";
import os from "node:os";

// --- Synthetic export generator -------------------------------------------
// Deterministic and seeded: the same run gives the same workload, so a change
// in the numbers reflects a change in the code, not in the data.

const BODIES = [
  "hey, how did the interview go?",
  "still waiting to hear back, honestly nervous",
  "you'll be fine, you prepared loads",
  "did you book the flights for april yet?",
  "not yet, waiting on my sister to confirm dates",
  "the marathon training is going well actually",
  "ran 18k on sunday, legs were dead",
  "that's brilliant, are you doing the full 42?",
  "that's the plan, assuming nothing breaks",
  "mum asked if you're coming at the weekend",
  "yes, saturday afternoon works",
  "ok I'll tell her, she'll be pleased",
  "sent you a photo of the new place",
  "IMG-20230101-WA0001.jpg (file attached)",
  "looks great, when do you move in?",
  "next month hopefully, paperwork is slow",
  "we should get dinner before then",
  "definitely, maybe the thai place?",
  "perfect, I'll book it",
  "can you send me that recipe btw?",
  "sure, it's in the other chat",
];

function makeExport(messageCount: number, seed = 42): string {
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const lines: string[] = [];
  const start = Date.UTC(2023, 0, 1, 9, 0, 0);
  for (let i = 0; i < messageCount; i += 1) {
    const who = i % 2 === 0 ? "Alex" : "Sam";
    const t = new Date(start + i * 7 * 60 * 1000);
    // Real WhatsApp export format: DD/MM/YYYY, HH:MM - Sender: body
    const dd = String(t.getUTCDate()).padStart(2, "0");
    const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = t.getUTCFullYear();
    const hh = String(t.getUTCHours()).padStart(2, "0");
    const mi = String(t.getUTCMinutes()).padStart(2, "0");
    const body = BODIES[Math.floor(rand() * BODIES.length)] ?? BODIES[0];
    lines.push(`${dd}/${mm}/${yyyy}, ${hh}:${mi} - ${who}: ${body}`);
  }
  return lines.join("\n");
}

// --- Timing ----------------------------------------------------------------

type Stats = { median: number; p95: number; mean: number; runs: number };

function measure(fn: () => void, runs = 7, warmup = 2): Stats {
  for (let i = 0; i < warmup; i += 1) fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6); // ms
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] ?? 0;
  const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] ?? 0;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { median, p95, mean, runs };
}

function fmt(n: number): string {
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function row(label: string, s: Stats, extra = ""): string {
  return `| ${label} | ${fmt(s.median)} | ${fmt(s.p95)} | ${fmt(s.mean)} | ${s.runs} |${extra ? ` ${extra} |` : ""}`;
}

// --- Workloads -------------------------------------------------------------

const SIZES = [1_000, 10_000, 50_000];

console.log("\n## Chat import parsing (`parseWhatsAppExport`)\n");
console.log("| Messages | Median ms | p95 ms | Mean ms | Runs | Throughput msg/s |");
console.log("| --- | --- | --- | --- | --- | --- |");

const parsedBySize = new Map<number, ReturnType<typeof parseWhatsAppExport>>();

for (const n of SIZES) {
  const input = makeExport(n);
  const bytes = Buffer.byteLength(input, "utf8");
  const stats = measure(() => {
    parseWhatsAppExport(input);
  });
  parsedBySize.set(n, parseWhatsAppExport(input));
  const throughput = Math.round(n / (stats.median / 1000));
  console.log(
    `| ${n.toLocaleString("en-US")} | ${fmt(stats.median)} | ${fmt(stats.p95)} | ${fmt(stats.mean)} | ${stats.runs} | ${throughput.toLocaleString("en-US")} |`,
  );
  console.log(
    `\n  (${n.toLocaleString("en-US")} messages = ${(bytes / 1024 / 1024).toFixed(1)} MB of export text)\n`,
  );
}

// --- Understanding ---------------------------------------------------------

function toAnalysisMessages(parsed: ReturnType<typeof parseWhatsAppExport>): AnalysisMessage[] {
  return parsed.messages.slice(0, 50_000).map((m, i) => ({
    id: `m${i}`,
    // ParsedMessage carries a sender label, not a direction; the self label is
    // the one the exporter wrote for the user, here "Alex".
    participant: m.senderLabel === null ? "system" : m.senderLabel === "Alex" ? "self" : "contact",
    senderLabel: m.senderLabel,
    sentAt: (m.sentAt ?? new Date(Date.UTC(2023, 0, 1))).toISOString(),
    body: m.body ?? "",
    kind: m.kind,
  }));
}

console.log("\n## Conversation understanding (`understandConversation`)\n");
console.log("| Input messages | Median ms | p95 ms | Mean ms | Runs |");
console.log("| --- | --- | --- | --- | --- |");

for (const n of SIZES) {
  const parsed = parsedBySize.get(n);
  if (!parsed) continue;
  const msgs = toAnalysisMessages(parsed);
  const stats = measure(
    () => {
      understandConversation(msgs);
    },
    5,
    1,
  );
  console.log(row(n.toLocaleString("en-US"), stats));
}

// --- Style profile ---------------------------------------------------------

console.log("\n## Communication style (`analyseConversationStyle`)\n");
console.log("| Input messages | Median ms | p95 ms | Mean ms | Runs |");
console.log("| --- | --- | --- | --- | --- |");

for (const n of SIZES) {
  const parsed = parsedBySize.get(n);
  if (!parsed) continue;
  const msgs = toAnalysisMessages(parsed);
  const stats = measure(
    () => {
      analyseConversationStyle(msgs);
    },
    5,
    1,
  );
  console.log(row(n.toLocaleString("en-US"), stats));
}

// --- Prompt build (fixed cost per request) --------------------------------

console.log("\n## Reply prompt construction (per request)\n");
console.log("| Operation | Median ms | p95 ms | Mean ms | Runs |");
console.log("| --- | --- | --- | --- | --- |");

const bigMsgs = toAnalysisMessages(
  parsedBySize.get(10_000) ?? parseWhatsAppExport(makeExport(10_000)),
);
const lastMsg = bigMsgs[bigMsgs.length - 1];
const style = analyseConversationStyle(bigMsgs);
const replyContext = {
  contactName: "Sam",
  selfName: "Alex",
  latestIncoming: lastMsg ?? null,
  recentMessages: bigMsgs.slice(-20),
  selfStyle: style.self,
  contactStyle: style.contact,
  openThreads: ["waiting on flights for april", "dinner before the move"],
  memories: Array.from({ length: 50 }, (_, i) => ({
    id: `mem${i}`,
    statement: `Fact number ${i} about the contact`,
    confidence: 0.8,
    isUserConfirmed: i % 3 === 0,
  })),
  tone: "warm",
};

console.log(
  row(
    "buildReplySystemPrompt",
    measure(() => void buildReplySystemPrompt(), 200, 20),
  ),
);
console.log(
  row(
    "buildReplyUserPrompt",
    measure(() => void buildReplyUserPrompt(replyContext), 200, 20),
  ),
);

console.log("\n## Environment\n");
console.log(`| Key | Value |`);
console.log(`| --- | --- |`);
console.log(`| Node | ${process.version} |`);
console.log(`| Platform | ${process.platform} ${process.arch} |`);
console.log(`| CPUs | ${os.cpus().length} |`);
console.log(`| Machine | (sandbox) |`);
console.log("\nGenerated by scripts/bench.ts — single process, no network, no database.\n");
