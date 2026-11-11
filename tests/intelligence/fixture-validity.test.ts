import { it, expect } from "vitest";
import {
  buildPriyaConversation,
  buildContradictionConversation,
  buildPriyaConversationExtended,
} from "../fixtures/conversations";
it("fixture timestamps are valid ISO and ordered", () => {
  for (const build of [
    buildPriyaConversation,
    buildContradictionConversation,
    buildPriyaConversationExtended,
  ]) {
    const rows = build();
    let prev = 0;
    for (const r of rows) {
      expect(r.sent_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const t = Date.parse(r.sent_at as string);
      expect(Number.isNaN(t)).toBe(false);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  }
});
