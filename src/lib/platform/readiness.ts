/**
 * Integration readiness.
 *
 * Reports what is and is not in place for an official WhatsApp connection, with
 * no assumptions. Every item is either evidenced from configuration or reported
 * as missing — nothing is marked ready because it "should work".
 *
 * The important property: `ready` is false in this build, always, because the
 * application has no webhook handler and no send path. Adding credentials alone
 * must not flip it to true, since that would be a false statement of readiness.
 */

export type ReadinessStatus = "ready" | "missing" | "unsupported";

export type ReadinessItem = {
  id: string;
  label: string;
  status: ReadinessStatus;
  /** Why it has this status, in plain words. */
  detail: string;
};

export type ReadinessReport = {
  /** True only when every blocking item is ready. */
  ready: boolean;
  /** True when this build contains the code needed to send at all. */
  sendPathImplemented: false;
  items: ReadinessItem[];
};

export type PlatformConfigView = {
  hasAccessToken: boolean;
  hasPhoneNumberId: boolean;
  hasVerifyToken: boolean;
  hasAppSecret: boolean;
  appUrl: string | null;
};

/**
 * Builds the readiness report.
 *
 * Deliberately never consults the network here: readiness is a statement about
 * configuration and code, and a network probe would conflate "unreachable from
 * this machine" with "not configured", which are different problems.
 */
export function buildReadinessReport(config: PlatformConfigView): ReadinessReport {
  const items: ReadinessItem[] = [
    {
      id: "send_path",
      label: "Outbound send path",
      status: "unsupported",
      // The single most important line in this file.
      detail:
        "Not implemented. Moti AI has no code that sends a WhatsApp message, and this build will not add one without the checks below.",
    },
    {
      id: "webhook_handler",
      label: "Webhook receiver",
      status: "unsupported",
      detail:
        "Not implemented. Receiving live messages needs a public HTTPS endpoint that verifies Meta's signature.",
    },
    {
      id: "access_token",
      label: "Meta access token",
      status: config.hasAccessToken ? "ready" : "missing",
      detail: config.hasAccessToken
        ? "Configured on the server. Not yet used, because there is nothing to send."
        : "Not configured. Created in a Meta app with WhatsApp enabled.",
    },
    {
      id: "phone_number_id",
      label: "WhatsApp phone number ID",
      status: config.hasPhoneNumberId ? "ready" : "missing",
      detail: config.hasPhoneNumberId
        ? "Configured. Must belong to a verified business portfolio."
        : "Not configured. Comes from the WhatsApp Business Account.",
    },
    {
      id: "business_verification",
      label: "Meta business verification",
      status: "missing",
      detail:
        "Not something this app can check. Until it is complete, messaging is capped at 250 unique contacts per rolling 24 hours.",
    },
    {
      id: "templates",
      label: "Approved message templates",
      status: "missing",
      detail:
        "None submitted. Needed for any message outside a 24-hour customer service window.",
    },
    {
      id: "public_url",
      label: "Public HTTPS endpoint",
      status: config.appUrl ? "ready" : "missing",
      detail: config.appUrl
        ? `Configured as ${config.appUrl}. Meta requires HTTPS and a reachable path.`
        : "Not configured. Meta must be able to reach your webhook over HTTPS.",
    },
    {
      id: "verify_token",
      label: "Webhook verify token",
      status: config.hasVerifyToken ? "ready" : "missing",
      detail: config.hasVerifyToken
        ? "Configured. Would be checked during webhook subscription."
        : "Not configured. Used once when subscribing the webhook.",
    },
    {
      id: "app_secret",
      label: "App secret for signature verification",
      status: config.hasAppSecret ? "ready" : "missing",
      detail: config.hasAppSecret
        ? "Configured. Would be used to verify webhook payloads."
        : "Not configured. Without it a webhook payload cannot be trusted.",
    },
  ];

  /*
   * Ready means "everything blocking is in place", not "most things are".
   * The unsupported items are blocking by definition, so this is false here and
   * stays false until this build actually gains those features.
   */
  const ready =
    items.every((item) => item.status === "ready") &&
    items.every((item) => item.status !== "unsupported");

  return { ready, sendPathImplemented: false, items };
}

/** Sums the report for display, without ever rounding "not ready" up to "ready". */
export function summariseReadiness(report: ReadinessReport): string {
  const ready = report.items.filter((item) => item.status === "ready").length;
  const missing = report.items.filter((item) => item.status === "missing").length;
  const unsupported = report.items.filter((item) => item.status === "unsupported").length;

  if (report.ready) return "Ready to connect.";

  return `${ready} of ${report.items.length} in place · ${missing} missing · ${unsupported} not implemented in this build`;
}
