import { describe, expect, it, vi } from "vitest";
import {
  AppError,
  ConflictError,
  NotFoundError,
  NotConfiguredError,
  UnauthorizedError,
  ValidationError,
  isAppError,
  toErrorResponse,
} from "@/lib/errors";

describe("application errors", () => {
  it("maps each code to the right HTTP status", () => {
    expect(new ValidationError({}).status).toBe(400);
    expect(new UnauthorizedError().status).toBe(401);
    expect(new NotFoundError().status).toBe(404);
    expect(new ConflictError("exists").status).toBe(409);
    expect(new NotConfiguredError().status).toBe(503);
  });

  it("serialises a typed error into a client-safe payload", () => {
    const { status, body } = toErrorResponse(
      new ValidationError({ email: "required" }, "Check the highlighted fields."),
    );

    expect(status).toBe(400);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toBe("Check the highlighted fields.");
    expect(body.error.details).toEqual({ email: "required" });
  });

  it("hides internal error details behind a generic 500", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { status, body } = toErrorResponse(
      new Error("connection string postgres://user:pass@host/db failed"),
    );

    expect(status).toBe(500);
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).not.toContain("postgres://");
    expect(body.error.message).not.toContain("pass");
    expect(consoleError).toHaveBeenCalledOnce();

    consoleError.mockRestore();
  });

  it("recognises its own errors and nothing else", () => {
    expect(isAppError(new NotFoundError())).toBe(true);
    expect(isAppError(new AppError("forbidden", "nope"))).toBe(true);
    expect(isAppError(new Error("plain"))).toBe(false);
    expect(isAppError("string")).toBe(false);
  });

  it("preserves the cause for server-side logging", () => {
    const cause = new Error("upstream timeout");
    const error = new AppError("internal_error", "Try again", { cause });
    expect(error.cause).toBe(cause);
  });
});
