/** Memory scaling for the parser. Peak RSS delta per workload size. */
import { parseWhatsAppExport } from "../src/lib/conversations/parser";

const BODY = "hey, how did the interview go? still waiting to hear back";
function makeExport(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = String((i % 28) + 1).padStart(2, "0");
    out.push(`${d}/01/2023, 09:00 - ${i % 2 ? "Sam" : "Alex"}: ${BODY}`);
  }
  return out.join("\n");
}
console.log("| Messages | Input MB | Heap used MB | Heap delta MB | Peak RSS MB | ms |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const n of [10_000, 50_000, 100_000]) {
  const input = makeExport(n);
  const inputMb = Buffer.byteLength(input, "utf8") / 1024 / 1024;
  global.gc?.();
  const before = process.memoryUsage();
  const t0 = process.hrtime.bigint();
  const parsed = parseWhatsAppExport(input);
  const t1 = process.hrtime.bigint();
  const after = process.memoryUsage();
  const ms = Number(t1 - t0) / 1e6;
  const heapMb = after.heapUsed / 1024 / 1024;
  const deltaMb = (after.heapUsed - before.heapUsed) / 1024 / 1024;
  const rssMb = after.rss / 1024 / 1024;
  console.log(
    `| ${n.toLocaleString("en-US")} | ${inputMb.toFixed(1)} | ${heapMb.toFixed(1)} | +${deltaMb.toFixed(1)} | ${rssMb.toFixed(1)} | ${ms.toFixed(0)} |`,
  );
  console.log(
    `  -> parsed ${parsed.messages.length.toLocaleString("en-US")} messages, warnings: ${parsed.warnings.length}`,
  );
  // free before next size
  (parsed.messages as unknown[]).length = 0;
}
