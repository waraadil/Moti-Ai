/**
 * Typed application errors.
 *
 * Server code throws `AppError` subclasses; route handlers convert them into
 * consistent JSON with `toErrorResponse`. Unexpected errors are logged and
 * reported as a generic 500 so internal details never reach the client.
 */

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "unsupported_media_type"
  | "not_configured"
  | "internal_error";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  not_configured: 503,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Safe to show to the end user. */
  readonly userMessage: string;
  /** Extra machine-readable context, e.g. field-level validation details. */
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    userMessage: string,
    options?: { cause?: unknown; details?: unknown },
  ) {
    super(userMessage, { cause: options?.cause });
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.userMessage = userMessage;
    this.details = options?.details;
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown, userMessage = "Some of the submitted values are not valid.") {
    super("bad_request", userMessage, { details });
    this.name = "ValidationError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(userMessage = "You need to sign in to continue.") {
    super("unauthorized", userMessage);
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends AppError {
  constructor(userMessage = "That record could not be found.") {
    super("not_found", userMessage);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(userMessage: string, details?: unknown) {
    super("conflict", userMessage, { details });
    this.name = "ConflictError";
  }
}

export class NotConfiguredError extends AppError {
  constructor(userMessage = "This feature is not configured yet.") {
    super("not_configured", userMessage);
    this.name = "NotConfiguredError";
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export type ErrorPayload = {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
};

/**
 * Converts any thrown value into a safe JSON payload plus an HTTP status.
 * Unknown errors are logged server-side and flattened for the client.
 */
export function toErrorResponse(error: unknown): { status: number; body: ErrorPayload } {
  if (isAppError(error)) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.userMessage,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    };
  }

  console.error("[moti] unhandled error", error);

  return {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message: "Something went wrong on our side. Please try again.",
      },
    },
  };
}
