import { describe, expect, it } from "vitest";
import { escapeLikePattern } from "@/server/messages/repository";
import { buildMessageRows, buildStoragePath } from "@/server/imports/repository";
import { parseWhatsAppExport, resolveDirections } from "@/lib/conversations/parser";
import { isAppError, type AppError } from "@/lib/errors";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const IMPORT_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";

describe("buildStoragePath", () => {
  it("prefixes the path with the user id so storage policies match", () => {
    expect(buildStoragePath(USER_ID, "abc", "chat.txt")).toBe(`${USER_ID}/abc/chat.txt`);
  });

  it("prevents path traversal through a crafted filename", () => {
    const path = buildStoragePath(USER_ID, "abc", "../../other-user/secret.txt");
    expect(path.startsWith(`${USER_ID}/`)).toBe(true);
    expect(path).not.toContain("../");
    expect(path.split("/")).toHaveLength(3);
  });

  it("truncates absurdly long filenames", () => {
    const path = buildStoragePath(USER_ID, "abc", `${"x".repeat(500)}.txt`);
    expect(path.length).toBeLessThan(USER_ID.length + 3 + 200 + 5);
  });
});

describe("escapeLikePattern", () => {
  it("escapes wildcards so a search for 50% is literal", () => {
    expect(escapeLikePattern("50%")).toBe("50\\%");
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
    expect(escapeLikePattern("c:\\temp")).toBe("c:\\\\temp");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeLikePattern("marathon training")).toBe("marathon training");
  });
});

describe("buildMessageRows", () => {
  const EXPORT = [
    "12/03/2024, 09:16 - Priya: Hey!",
    "12/03/2024, 09:18 - You: Hello",
    "12/03/2024, 09:19 - Priya: <Media omitted>",
  ].join("\n");

  it("produces one row per parsed message with deterministic fingerprints", () => {
    const parsed = parseWhatsAppExport(EXPORT);
    const directions = resolveDirections(parsed.messages, ["You"]);

    const rows = buildMessageRows({
      userId: USER_ID,
      importId: IMPORT_ID,
      contactId: CONTACT_ID,
      messages: parsed.messages,
      directions,
    });

    expect(rows).toHaveLength(3);
    expect(rows[0]?.source_fingerprint).toBe(`${IMPORT_ID}:1`);
    expect(rows[0]?.direction).toBe("incoming");
    expect(rows[1]?.direction).toBe("outgoing");
    expect(rows[2]?.kind).toBe("media");
    expect(rows.every((row) => row.user_id === USER_ID)).toBe(true);
    expect(rows.every((row) => row.contact_id === CONTACT_ID)).toBe(true);
  });

  it("is stable across repeated parses, so re-imports collide instead of duplicating", () => {
    const build = () => {
      const parsed = parseWhatsAppExport(EXPORT);
      return buildMessageRows({
        userId: USER_ID,
        importId: IMPORT_ID,
        contactId: CONTACT_ID,
        messages: parsed.messages,
        directions: resolveDirections(parsed.messages, ["You"]),
      }).map((row) => row.source_fingerprint);
    };

    expect(build()).toEqual(build());
  });

  it("refuses mismatched message and direction counts", () => {
    const parsed = parseWhatsAppExport(EXPORT);
    try {
      buildMessageRows({
        userId: USER_ID,
        importId: IMPORT_ID,
        contactId: CONTACT_ID,
        messages: parsed.messages,
        directions: [{ direction: "incoming" }],
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      expect((error as AppError).code).toBe("bad_request");
      // The message must be user-facing, not buried in `details`.
      expect((error as AppError).userMessage).toMatch(/counts disagree/i);
    }
  });

  it("stores timestamps as ISO strings and keeps them null when unknown", () => {
    const parsed = parseWhatsAppExport(EXPORT);
    const rows = buildMessageRows({
      userId: USER_ID,
      importId: IMPORT_ID,
      contactId: CONTACT_ID,
      messages: parsed.messages,
      directions: resolveDirections(parsed.messages, ["You"]),
    });

    expect(rows[0]?.sent_at).toBe("2024-03-12T09:16:00.000Z");
  });
});
