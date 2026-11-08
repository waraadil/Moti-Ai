#!/usr/bin/env node
/**
 * Self-verification script for the AI provider.
 *
 *   npm run verify:provider
 *
 * Runs the same diagnostic the app uses, from your machine, with your .env.local.
 * It tells you plainly whether the configured endpoint is reachable, whether the
 * key is accepted, and whether the model name exists — without ever printing the
 * key.
 *
 * Exit codes: 0 healthy, 1 unhealthy, 2 configuration missing.
 */

import { loadEnvFile } from "node:process";
import { diagnoseProvider } from "../src/lib/ai/diagnose";
import { describeProvider } from "../src/lib/ai/config";

function colour(code: string, text: string): string {
  // Respect NO_COLOR (https://no-color.org) and non-TTY output.
  if (process.env.NO_COLOR || !process.stdout.isTTY) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

const ok = (text: string) => colour("32", text);
const bad = (text: string) => colour("31", text);
const dim = (text: string) => colour("2", text);
const bold = (text: string) => colour("1", text);

async function main() {
  // Next.js loads .env.local automatically; a plain node script does not.
  try {
    loadEnvFile(".env.local");
  } catch {
    // No .env.local is not fatal: variables may come from the real environment.
  }

  console.log(bold("\nMoti AI — provider self-verification\n"));

  const summary = describeProvider();

  console.log(`  provider   ${bold(String(summary.provider))}`);
  console.log(`  model      ${summary.model ?? dim("(none — rule engine)")}`);
  console.log(`  endpoint   ${summary.baseUrl ?? dim("(no network)")}`);
  console.log(`  api key    ${summary.hasApiKey ? ok("present") : dim("absent")}`);
  console.log();

  if (!summary.configured) {
    console.log(bad("Configuration is invalid."));
    console.log(`\n${summary.error ?? ""}`);

    if (summary.requiredVariables.length > 0) {
      console.log(
        `\nSet ${bold(summary.requiredVariables.join(", "))} in .env.local, then re-run.`,
      );
    }
    if (summary.provider === "deterministic") {
      console.log(
        `\n${dim("Note: deterministic mode needs no key. This error came from another setting.")}`,
      );
    }
    console.log(`\n${dim("See README.md → Analysis engine → Setup.")}\n`);
    process.exit(2);
  }

  if (summary.provider === "deterministic") {
    console.log(ok("Deterministic rule engine is active."));
    console.log(
      dim(
        "\nThis is offline analysis, not a language model. No network call was made,\n" +
          "and no endpoint was tested. To verify a real model, set:\n" +
          "  MOTI_ANALYSIS_PROVIDER=groq        (or openai / gemini / anthropic / ...)\n" +
          "  MOTI_ANALYSIS_API_KEY=your-key\n",
      ),
    );
    process.exit(0);
  }

  console.log(dim("Running checks (a few tokens will be used by the completion probe)…\n"));

  const report = await diagnoseProvider({ skipCompletion: false });

  for (const check of report.checks) {
    const label = check.ok ? ok("PASS") : bad("FAIL");
    console.log(`${label}  ${bold(check.stage.padEnd(13))} ${check.detail}`);
    if (check.hint) console.log(`      ${dim(check.hint)}`);
    console.log();
  }

  if (report.ok) {
    console.log(ok("Everything checks out. Real AI analysis is working."));
    console.log(
      dim(
        "\nRecorded on every analysis: " +
          `${report.provider} · ${report.model}\n` +
          "You can now set MOTI_ANALYSIS_PROVIDER in .env.local and use the Analyse button.\n",
      ),
    );
    process.exit(0);
  }

  console.log(bad("Verification failed."));

  if (report.errorKind === "network") {
    console.log(
      dim(
        "\nYour network cannot reach the endpoint. This is not a key or code problem.\n" +
          "Common causes: a corporate VPN or firewall, a sandbox with restricted egress,\n" +
          "or a mobile carrier blocking the host. Try a different network, or a local\n" +
          "runtime (MOTI_ANALYSIS_PROVIDER=ollama with Ollama running on your machine).\n",
      ),
    );
  }

  if (report.errorKind === "auth") {
    console.log(
      dim(
        "\nThe endpoint is reachable — only the key is wrong. Check for typos or a revoked key.\n",
      ),
    );
  }

  process.exit(1);
}

main().catch((error) => {
  console.error(bad("\nThe verification script crashed:"));
  console.error(error);
  process.exit(1);
});
