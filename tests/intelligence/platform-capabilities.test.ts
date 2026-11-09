/**
 * Platform capability honesty.
 *
 * Phase 5 is judged on one thing above all: the app must not claim a
 * connection or a send path it does not have. These tests encode that as
 * assertions, including the case where every credential is configured.
 */

import { describe, expect, it } from "vitest";
import {
  HAS_LIVE_PLATFORM_CONNECTION,
  OFFERED_PATHS,
  PLATFORMS,
  UNOFFICIAL_CLIENT_STANCE,
  WHATSAPP,
  sendCapability,
} from "@/lib/platform/capabilities";
import {
  buildReadinessReport,
  summariseReadiness,
  type PlatformConfigView,
} from "@/lib/platform/readiness";

const NOTHING_CONFIGURED: PlatformConfigView = {
  hasAccessToken: false,
  hasPhoneNumberId: false,
  hasVerifyToken: false,
  hasAppSecret: false,
  appUrl: null,
};

const EVERYTHING_CONFIGURED: PlatformConfigView = {
  hasAccessToken: true,
  hasPhoneNumberId: true,
  hasVerifyToken: true,
  hasAppSecret: true,
  appUrl: "https://moti.example.com",
};

describe("send capability", () => {
  it("reports that Moti cannot send", () => {
    const send = sendCapability();
    expect(send.canSend).toBe(false);
    expect(send.reason).toContain("no outbound integration");
  });

  it("has no live connection to any platform", () => {
    expect(HAS_LIVE_PLATFORM_CONNECTION).toBe(false);
  });
});

describe("WhatsApp profile", () => {
  it("states that messages are imported from an export, not received live", () => {
    expect(WHATSAPP.capabilities.canReceiveAutomatically).toBe(false);
    expect(WHATSAPP.capabilities.canImportFromExport).toBe(true);
    expect(WHATSAPP.currentState).toContain("export");
  });

  it("does not claim official API sending", () => {
    expect(WHATSAPP.capabilities.canSendThroughOfficialApi).toBe(false);
    expect(WHATSAPP.path).toBe("export_file");
  });

  it("records the real constraints a user would face", () => {
    const text = WHATSAPP.limitations.join(" ");
    expect(text).toContain("24-hour");
    expect(text).toContain("template");
  });

  it("is the only platform offered", () => {
    expect(PLATFORMS).toHaveLength(1);
    expect(PLATFORMS[0]).toBe(WHATSAPP);
  });
});

describe("offered paths", () => {
  it("never offers an unofficial client", () => {
    const paths = OFFERED_PATHS.map((option) => option.path);
    expect(paths).not.toContain("unofficial_client");
  });

  it("offers exactly the export path and the official business API", () => {
    expect(OFFERED_PATHS.map((option) => option.path)).toEqual([
      "export_file",
      "official_business_api",
    ]);
  });

  it("records why unofficial clients are refused", () => {
    expect(UNOFFICIAL_CLIENT_STANCE.supported).toBe(false);
    expect(UNOFFICIAL_CLIENT_STANCE.reason).toContain("terms of service");
  });
});

describe("readiness report", () => {
  it("is not ready with nothing configured", () => {
    const report = buildReadinessReport(NOTHING_CONFIGURED);
    expect(report.ready).toBe(false);
    expect(report.sendPathImplemented).toBe(false);
  });

  /*
   * The critical case. Supplying every credential must not make the app claim it
   * can send, because the code to send does not exist. Anything else would be a
   * false statement to the operator who configured it.
   */
  it("is still not ready even with every credential configured", () => {
    const report = buildReadinessReport(EVERYTHING_CONFIGURED);

    expect(report.ready).toBe(false);
    expect(report.sendPathImplemented).toBe(false);

    const unsupported = report.items.filter((item) => item.status === "unsupported");
    expect(unsupported.map((item) => item.id)).toEqual(["send_path", "webhook_handler"]);
  });

  it("marks credentials as in place when present, without calling them working", () => {
    const report = buildReadinessReport(EVERYTHING_CONFIGURED);
    const token = report.items.find((item) => item.id === "access_token");

    expect(token?.status).toBe("ready");
    // "Configured" is not "working": the detail must say it is unused.
    expect(token?.detail).toContain("Not yet used");
  });

  it("reports each missing credential separately", () => {
    const report = buildReadinessReport(NOTHING_CONFIGURED);
    const missing = report.items.filter((item) => item.status === "missing").map((i) => i.id);

    expect(missing).toEqual(
      expect.arrayContaining([
        "access_token",
        "phone_number_id",
        "business_verification",
        "templates",
        "public_url",
        "verify_token",
        "app_secret",
      ]),
    );
  });

  it("never marks items this app cannot verify as ready", () => {
    const report = buildReadinessReport(EVERYTHING_CONFIGURED);
    // Business verification and templates happen in Meta's systems, not here.
    expect(report.items.find((i) => i.id === "business_verification")?.status).toBe("missing");
    expect(report.items.find((i) => i.id === "templates")?.status).toBe("missing");
  });

  it("summarises without rounding not-ready up to ready", () => {
    const summary = summariseReadiness(buildReadinessReport(EVERYTHING_CONFIGURED));
    expect(summary).not.toBe("Ready to connect.");
    expect(summary).toContain("not implemented");
  });

  it("says ready only in the hypothetical where nothing is blocking", () => {
    // A config that would be ready if the code existed. It must still fail,
    // because two items are unsupported regardless of configuration.
    const report = buildReadinessReport(EVERYTHING_CONFIGURED);
    expect(report.items.some((item) => item.status === "unsupported")).toBe(true);
    expect(report.ready).toBe(false);
  });

  it("mentions the HTTPS requirement when no public url is set", () => {
    const report = buildReadinessReport(NOTHING_CONFIGURED);
    const url = report.items.find((item) => item.id === "public_url");
    expect(url?.detail).toContain("HTTPS");
  });
});
