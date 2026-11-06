"use server";

/**
 * Authentication server actions.
 *
 * These run on the server only, and return a discriminated result instead of
 * redirecting on error so the form can show inline messages without losing
 * what the user typed.
 */

import { redirect } from "next/navigation";
import { z } from "zod";
import { NotConfiguredError } from "@/lib/errors";
import { isPublicEnvConfigured } from "@/lib/env";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type AuthActionResult =
  | { ok: true }
  | {
      ok: false;
      message: string;
      /** Field-level messages keyed by input name. */
      fieldErrors?: Record<string, string>;
    };

const emailSchema = z.email("Enter a valid email address.").max(320);
const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters.")
  .max(200, "That password is too long.");

const credentialsSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

const signUpSchema = credentialsSchema.extend({
  displayName: z.string().trim().min(1, "Tell us what to call you.").max(120),
});

function collectFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !fieldErrors[field]) {
      fieldErrors[field] = issue.message;
    }
  }
  return fieldErrors;
}

/** Only allow same-origin relative paths as post-login destinations. */
function safeNextPath(next: FormDataEntryValue | null): string {
  if (typeof next !== "string") return "/contacts";
  if (!next.startsWith("/") || next.startsWith("//")) return "/contacts";
  return next;
}

export async function signInAction(formData: FormData): Promise<AuthActionResult> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: "Check the highlighted fields.",
      fieldErrors: collectFieldErrors(parsed.error),
    };
  }

  try {
    if (!isPublicEnvConfigured()) throw new NotConfiguredError();
    const supabase = await createServerSupabaseClient();

    const { error } = await supabase.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });

    if (error) {
      // Deliberately vague: never confirm whether an email address exists.
      return { ok: false, message: "Those sign-in details are not correct." };
    }
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return {
        ok: false,
        message: "Supabase is not configured yet. Add your project keys to .env.local.",
      };
    }
    console.error("[moti] sign-in failed", error);
    return { ok: false, message: "We could not reach the authentication service. Try again." };
  }

  redirect(safeNextPath(formData.get("next")));
}

export async function signUpAction(formData: FormData): Promise<AuthActionResult> {
  const parsed = signUpSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    displayName: formData.get("displayName"),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: "Check the highlighted fields.",
      fieldErrors: collectFieldErrors(parsed.error),
    };
  }

  try {
    if (!isPublicEnvConfigured()) throw new NotConfiguredError();
    const supabase = await createServerSupabaseClient();

    const { data, error } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: {
        // The handle_new_user() trigger copies display_name into public.profiles.
        data: { display_name: parsed.data.displayName },
        emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/auth/callback`,
      },
    });

    if (error) {
      return { ok: false, message: error.message };
    }

    // Email confirmation enabled: no session yet, so tell the user to check inbox.
    if (!data.session) {
      return {
        ok: false,
        message: "Account created. Confirm your email address to finish signing up, then sign in.",
      };
    }
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return {
        ok: false,
        message: "Supabase is not configured yet. Add your project keys to .env.local.",
      };
    }
    console.error("[moti] sign-up failed", error);
    return { ok: false, message: "We could not create your account. Try again." };
  }

  redirect("/contacts");
}

export async function signOutAction(): Promise<void> {
  if (isPublicEnvConfigured()) {
    const supabase = await createServerSupabaseClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}
