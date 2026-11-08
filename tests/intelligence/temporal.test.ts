import { describe, expect, it } from "vitest";
import {
  buildSnapshot,
  diffSnapshots,
  type ConversationSnapshot,
} from "@/lib/intelligence/temporal";
import { analyseConversationStyle } from "@/lib/intelligence/style";
import { understandConversation } from "@/lib/intelligence/understanding";
import { toAnalysisInput } from "@/server/analysis/pipeline";
import { buildPriyaConversation, buildPriyaConversationExtended } from "../fixtures/conversations";

const OPTIONS = { contactName: "Priya", selfName: "Wara" };

function snapshotOf(
  rows: ReturnType<typeof buildPriyaConversation>,
  memoryFingerprints: string[] = [],
) {
  const input = toAnalysisInput(rows, OPTIONS);
  const understanding = understandConversation(input.messages);
  const style = analyseConversationStyle(input.messages);

  return buildSnapshot({
    cutoffAt: input.messages[input.messages.length - 1]?.sentAt ?? "2024-03-05T00:00:00.000Z",
    messageCount: input.messages.length,
    understanding,
    style,
    memoryFingerprints,
  });
}

describe("snapshots", () => {
  it("capture a comparable summary of the conversation", () => {
    const snapshot = snapshotOf(buildPriyaConversation(), ["fp-1", "fp-2"]);

    expect(snapshot.messageCount).toBeGreaterThan(30);
    expect(snapshot.topics.length).toBeGreaterThan(0);
    expect(snapshot.memoryFingerprints).toEqual(["fp-1", "fp-2"]);
    expect(snapshot.style?.self.messageCount).toBeGreaterThan(0);
    expect(snapshot.style?.contact.messageCount).toBeGreaterThan(0);
  });

  it("round-trips through JSON unchanged, so jsonb storage is lossless", () => {
    const snapshot = snapshotOf(buildPriyaConversation());
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});

describe("temporal diff", () => {
  it("reports no changes when there is no previous analysis", () => {
    const current = snapshotOf(buildPriyaConversation());
    const diff = diffSnapshots(null, current, understandConversation([]));

    expect(diff.hasPrevious).toBe(false);
    expect(diff.changes).toEqual([]);
    expect(diff.previousCutoffAt).toBeNull();
  });

  it("detects new messages after a later import", () => {
    const previous = snapshotOf(buildPriyaConversation());
    const extended = buildPriyaConversationExtended();
    const current = snapshotOf(extended);

    const diff = diffSnapshots(previous, current, understandConversation([]));

    expect(diff.hasPrevious).toBe(true);
    expect(diff.newMessageCount).toBe(3);
    expect(diff.changes.some((change) => change.kind === "new_messages")).toBe(true);
  });

  it("detects newly learned memories", () => {
    const previous = snapshotOf(buildPriyaConversation(), ["fp-1"]);
    const current = snapshotOf(buildPriyaConversationExtended(), ["fp-1", "fp-2", "fp-3"]);

    const diff = diffSnapshots(previous, current, understandConversation([]));

    const memoryChange = diff.changes.find((change) => change.kind === "new_memory");
    expect(memoryChange?.summary).toMatch(/2 new memories/i);
  });

  it("reports nothing new when the conversation has not changed", () => {
    const snapshot = snapshotOf(buildPriyaConversation(), ["fp-1"]);
    const diff = diffSnapshots(snapshot, snapshot, understandConversation([]));

    expect(diff.newMessageCount).toBe(0);
    expect(diff.changes.some((change) => change.kind === "new_messages")).toBe(false);
    expect(diff.changes.some((change) => change.kind === "new_memory")).toBe(false);
  });

  it("does not declare a topic gone from a tiny window", () => {
    const previous: ConversationSnapshot = {
      cutoffAt: "2024-01-01T00:00:00.000Z",
      messageCount: 40,
      topics: [{ label: "health", mentions: 5 }],
      plans: [],
      openThreads: [],
      memoryFingerprints: [],
      style: null,
    };

    const current: ConversationSnapshot = {
      ...previous,
      messageCount: 42, // only two new messages
      topics: [],
    };

    const diff = diffSnapshots(previous, current, understandConversation([]));
    expect(diff.changes.some((change) => change.kind === "topic_gone_quiet")).toBe(false);
  });

  it("declares a topic gone when it had real presence and the window is large", () => {
    const previous: ConversationSnapshot = {
      cutoffAt: "2024-01-01T00:00:00.000Z",
      messageCount: 40,
      topics: [{ label: "health", mentions: 6 }],
      plans: [],
      openThreads: [],
      memoryFingerprints: [],
      style: null,
    };

    const current: ConversationSnapshot = { ...previous, messageCount: 80, topics: [] };

    const diff = diffSnapshots(previous, current, understandConversation([]));
    expect(diff.changes.some((change) => change.kind === "topic_gone_quiet")).toBe(true);
  });

  it("detects a plan reaching completion", () => {
    const previous: ConversationSnapshot = {
      cutoffAt: "2024-01-01T00:00:00.000Z",
      messageCount: 10,
      topics: [],
      plans: [{ description: "I'll book a table", status: "agreed" }],
      openThreads: [],
      memoryFingerprints: [],
      style: null,
    };

    const current: ConversationSnapshot = {
      ...previous,
      messageCount: 12,
      plans: [{ description: "I'll book a table", status: "completed" }],
    };

    const diff = diffSnapshots(previous, current, understandConversation([]));
    expect(diff.changes.some((change) => change.kind === "plan_completed")).toBe(true);
  });

  it("detects a plan being cancelled", () => {
    const previous: ConversationSnapshot = {
      cutoffAt: "2024-01-01T00:00:00.000Z",
      messageCount: 10,
      topics: [],
      plans: [{ description: "Book the van next week", status: "agreed" }],
      openThreads: [],
      memoryFingerprints: [],
      style: null,
    };

    const current: ConversationSnapshot = {
      ...previous,
      plans: [{ description: "Book the van next week", status: "cancelled" }],
    };

    const diff = diffSnapshots(previous, current, understandConversation([]));
    expect(diff.changes.some((change) => change.kind === "plan_cancelled")).toBe(true);
  });

  it("detects an open thread being resolved", () => {
    const previous: ConversationSnapshot = {
      cutoffAt: "2024-01-01T00:00:00.000Z",
      messageCount: 10,
      topics: [],
      plans: [],
      openThreads: ["social"],
      memoryFingerprints: [],
      style: null,
    };

    const current: ConversationSnapshot = { ...previous, messageCount: 14, openThreads: [] };

    const diff = diffSnapshots(previous, current, understandConversation([]));
    expect(diff.changes.some((change) => change.kind === "thread_resolved")).toBe(true);
  });
});
