/**
 * What Moti AI can and cannot do per platform.
 *
 * This module exists to make one thing impossible: claiming a capability the app
 * does not have. Every surface that talks about connecting to WhatsApp reads its
 * wording from here, so the app cannot say "connected" in one place and "not
 * supported" in another.
 *
 * The facts below are the official Meta limits, as of the 2026 WhatsApp Business
 * Platform (Cloud API is the only supported official deployment; the On-Premises
 * API reached end of life in October 2025). They are recorded because a user
 * deciding whether to connect a number needs to know them *before* committing,
 * not after a template is rejected.
 */

/** How a platform can be connected, if at all. */
export type IntegrationPath =
  | "export_file"
  | "official_business_api"
  | "unofficial_client"
  | "not_supported";

export type Capability = {
  /** Can the app read messages from this platform automatically? */
  canReceiveAutomatically: boolean;
  /** Can the app deliver a message through the platform's official API? */
  canSendThroughOfficialApi: boolean;
  /** Can the app work from a manual export file instead? */
  canImportFromExport: boolean;
};

export type PlatformProfile = {
  id: "whatsapp" | "sms" | "telegram" | "signal" | "instagram" | "email";
  name: string;
  path: IntegrationPath;
  capabilities: Capability;
  /** Plain statement of what works today in this app. */
  currentState: string;
  /** What would be required to connect officially. */
  requirements: string[];
  /** Constraints a user must know before relying on it. */
  limitations: string[];
};

/**
 * WhatsApp.
 *
 * Moti AI currently supports the export path only. It imports a `.txt` export
 * the user produced themselves. There is no live connection: no webhook, no
 * token, no number registered against this deployment.
 */
export const WHATSAPP: PlatformProfile = {
  id: "whatsapp",
  name: "WhatsApp",
  path: "export_file",
  capabilities: {
    canReceiveAutomatically: false,
    canSendThroughOfficialApi: false,
    canImportFromExport: true,
  },
  currentState:
    "Moti reads a WhatsApp chat export you create and upload yourself. It is a snapshot: new messages require a new export.",
  requirements: [
    "A Meta business portfolio and a WhatsApp Business Account for live messaging",
    "Business verification before messaging at any useful scale (250 unique contacts per rolling 24 hours until verified)",
    "A phone number that is not already active on WhatsApp, or a migrated one",
    "An approved display name",
    "Pre-approved message templates for anything outside a 24-hour window",
    "A public HTTPS endpoint for webhooks, with signature verification",
  ],
  limitations: [
    "Free-form replies are only permitted inside a 24-hour window that opens when the other person messages you",
    "Outside that window only pre-approved templates may be sent, and casual follow-ups are usually categorised as marketing, the most expensive category",
    "Group messaging on the official API is restricted (capped at 8 participants and gated behind an Official Business Account), unlike a normal WhatsApp account",
    "Meta's free tier is shrinking: service messages inside the 24-hour window became chargeable in October 2026 in most markets",
    "Default throughput is 80 messages per second per number, rising automatically for high-volume numbers",
  ],
};

/**
 * Unofficial clients (QR-code pairing, reverse-engineered protocols).
 *
 * This is deliberately recorded as unsupported rather than merely unimplemented.
 * Using one breaches WhatsApp's terms and risks the user's number being banned.
 * It is not a capability this project will add, so it must not appear as a
 * roadmap item that a user could wait for.
 */
export const UNOFFICIAL_CLIENT_STANCE = {
  supported: false,
  reason:
    "Unofficial WhatsApp clients reverse-engineer a private protocol, breach WhatsApp's terms of service, and put the user's phone number at risk of a permanent ban. Moti AI will not implement one.",
} as const;

/**
 * True when the app has no live connection to any platform.
 *
 * Read by the UI so that no surface can imply a connection exists.
 */
export const HAS_LIVE_PLATFORM_CONNECTION = false;

export type SendCapability = {
  canSend: false;
  reason: string;
};

/**
 * The send capability for this build.
 *
 * Typed as `canSend: false` rather than `boolean` on purpose: turning sending on
 * requires changing this type and every switch that reads it, which is a
 * deliberate speed bump on the one decision that must never happen by accident.
 */
export function sendCapability(): SendCapability {
  return {
    canSend: false,
    reason:
      "Moti AI has no outbound integration. It prepares text for you to send yourself.",
  };
}

export const PLATFORMS: PlatformProfile[] = [WHATSAPP];

/** The paths a user may be offered. Unofficial clients are never among them. */
export const OFFERED_PATHS: Array<{ path: IntegrationPath; label: string; description: string }> = [
  {
    path: "export_file",
    label: "Upload an export",
    description:
      "Create the chat export in WhatsApp yourself and upload the .txt file. Works today, no setup.",
  },
  {
    path: "official_business_api",
    label: "WhatsApp Business Cloud API",
    description:
      "The only sanctioned way to send programmatically. Not connected in this build; requires Meta business verification and template approval.",
  },
];
