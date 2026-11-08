/**
 * Read-side helpers for the contact page's analysis panels.
 *
 * Deliberately NOT a `"use server"` module: these take a Supabase client and a
 * user id, so they must never be reachable as callable endpoints. The only
 * server action is `runAnalysisAction`.
 */

import "server-only";

import type { MessageRow } from "@/lib/supabase/database.types";
import type { ServerSupabaseClient } from "@/lib/supabase/server";
import { createProvider } from "@/lib/ai";
import { analysisProviderLabel, runAnalysis, toAnalysisInput } from "./pipeline";
import { listMessages } from "@/server/messages/repository";
import { listMemoriesWithEvidence } from "@/server/memories/repository";
import { latestVersion } from "./repository";
import { analyseConversationStyle } from "@/lib/intelligence/style";
import { understandConversation } from "@/lib/intelligence/understanding";

const MAX_MESSAGES_TO_LOAD = 3000;

/**
 * Loads the whole stored conversation for a contact, oldest first.
 * Paginated because Supabase caps a single response.
 */
export async function loadConversation(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
): Promise<MessageRow[]> {
  const all: MessageRow[] = [];
  let offset = 0;

  for (;;) {
    const page = await listMessages(supabase, userId, contactId, { limit: 500, offset });
    all.push(...page.messages);
    if (!page.hasMore) break;
    offset += 500;
    if (all.length >= MAX_MESSAGES_TO_LOAD) break;
  }

  const unique = new Map(all.map((message) => [message.id, message]));
  return [...unique.values()].sort((a, b) => {
    const left = a.sent_at ? Date.parse(a.sent_at) : 0;
    const right = b.sent_at ? Date.parse(b.sent_at) : 0;
    return left - right;
  });
}

/** Re-exported so the action does not need to import the pipeline directly. */
export { analysisProviderLabel, runAnalysis, toAnalysisInput, createProvider };

/** Everything the contact page needs to render analysis state. */
export type ContactAnalysisView = {
  providerLabel: string;
  latestVersion: Awaited<ReturnType<typeof latestVersion>>;
  selfProfile: {
    summary: string;
    messageCount: number;
    confidence: number;
    level: string;
  } | null;
  contactProfile: {
    summary: string;
    messageCount: number;
    confidence: number;
    level: string;
  } | null;
  topics: Array<{ label: string; mentions: number }>;
  openThreads: Array<{ topic: string; reason: string }>;
  plans: Array<{ description: string; status: string; evidenceCount: number }>;
  trusted: boolean;
  problem: string | null;
  messageCount: number;
};

export async function loadContactAnalysisView(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
  contactName: string,
): Promise<ContactAnalysisView> {
  let providerLabel = "not configured";
  try {
    providerLabel = analysisProviderLabel(createProvider());
  } catch {
    // A missing key must not break the page: fall back to a clear label.
    providerLabel = "unavailable (no provider configured)";
  }

  const version = await latestVersion(supabase, userId, contactId, "memory_extraction");

  if (!version) {
    return {
      providerLabel,
      latestVersion: null,
      selfProfile: null,
      contactProfile: null,
      topics: [],
      openThreads: [],
      plans: [],
      trusted: true,
      problem: null,
      messageCount: 0,
    };
  }

  const output = version.output as {
    style?: {
      selfSummary?: string;
      contactSummary?: string;
      self?: { messageCount: number; confidence: number; coverage?: { level: string } };
      contact?: { messageCount: number; confidence: number; coverage?: { level: string } };
    };
    understanding?: {
      topics?: Array<{ label: string; mentions: number }>;
      openThreads?: Array<{ topic: string; reason: string }>;
      plans?: Array<{
        description: string;
        status: string;
        citations?: Array<{ messageId: string }>;
      }>;
    };
    attribution?: { contactLabel?: string | null };
  } | null;

  void contactName;

  return {
    providerLabel,
    latestVersion: version,
    selfProfile: output?.style?.self
      ? {
          summary: output.style.selfSummary ?? "",
          messageCount: output.style.self.messageCount,
          confidence: output.style.self.confidence,
          level: output.style.self.coverage?.level ?? "unknown",
        }
      : null,
    contactProfile: output?.style?.contact
      ? {
          summary: output.style.contactSummary ?? "",
          messageCount: output.style.contact.messageCount,
          confidence: output.style.contact.confidence,
          level: output.style.contact.coverage?.level ?? "unknown",
        }
      : null,
    topics: output?.understanding?.topics?.slice(0, 8) ?? [],
    openThreads: output?.understanding?.openThreads ?? [],
    // Plans are read from the stored version output: there is no separate table.
    plans: (output?.understanding?.plans ?? []).map((plan) => ({
      description: plan.description,
      status: plan.status,
      evidenceCount: plan.citations?.length ?? 0,
    })),
    trusted: true,
    problem: null,
    messageCount: version.message_count,
  };
}

/**
 * Recomputes style metrics from the stored messages without writing anything.
 * Exposed so the page can show an honest "not analysed yet" preview.
 */
export async function previewEvidence(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
  contactName: string,
) {
  const messages = await loadConversation(supabase, userId, contactId);
  if (messages.length === 0) return { messageCount: 0, usable: false };

  const input = toAnalysisInput(messages, { contactName, selfName: null });
  const style = analyseConversationStyle(input.messages);
  const understanding = understandConversation(input.messages);

  return {
    messageCount: messages.length,
    usable: style.self.messageCount > 0 && style.contact.messageCount > 0,
    selfMessages: style.self.messageCount,
    contactMessages: style.contact.messageCount,
    topics: understanding.topics.slice(0, 5),
  };
}

/** Memories loaded for the page; kept here so the page does one import. */
export async function loadMemories(
  supabase: ServerSupabaseClient,
  userId: string,
  contactId: string,
) {
  return listMemoriesWithEvidence(supabase, userId, contactId, { limit: 20 });
}
