/**
 * Server-side platform readiness.
 *
 * Reads configuration and reports presence only. It never returns a token, a
 * prefix of a token, or its length: readiness is a yes/no question and the
 * answer does not need the secret.
 */

import "server-only";

import { getServerEnv } from "@/lib/env/server";
import {
  buildReadinessReport,
  summariseReadiness,
  type PlatformConfigView,
  type ReadinessReport,
} from "@/lib/platform/readiness";
import { HAS_LIVE_PLATFORM_CONNECTION, WHATSAPP } from "@/lib/platform/capabilities";

export type PlatformStatus = {
  platform: typeof WHATSAPP;
  report: ReadinessReport;
  summary: string;
  /** Always false in this build; read from one place so the UI cannot drift. */
  hasLiveConnection: boolean;
};

/**
 * Reads the environment defensively: a malformed value must not crash the page
 * that is supposed to explain configuration problems.
 */
function readConfig(): PlatformConfigView {
  try {
    const env = getServerEnv();
    return {
      hasAccessToken: Boolean(env.WHATSAPP_ACCESS_TOKEN),
      hasPhoneNumberId: Boolean(env.WHATSAPP_PHONE_NUMBER_ID),
      hasVerifyToken: Boolean(env.WHATSAPP_VERIFY_TOKEN),
      hasAppSecret: Boolean(env.WHATSAPP_APP_SECRET),
      appUrl: env.MOTI_ANALYSIS_APP_URL ?? null,
    };
  } catch {
    return {
      hasAccessToken: false,
      hasPhoneNumberId: false,
      hasVerifyToken: false,
      hasAppSecret: false,
      appUrl: null,
    };
  }
}

export function loadPlatformStatus(): PlatformStatus {
  const report = buildReadinessReport(readConfig());

  return {
    platform: WHATSAPP,
    report,
    summary: summariseReadiness(report),
    hasLiveConnection: HAS_LIVE_PLATFORM_CONNECTION,
  };
}
