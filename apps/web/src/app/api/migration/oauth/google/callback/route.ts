import { NextRequest, NextResponse } from "next/server";
import { isDbUnavailableError } from "@/lib/auth-errors";
import { verifyOAuthState } from "@/lib/migration/oauth-state";
import { exchangeGoogleCode } from "@/lib/migration/providers/google";
import { storeOAuthTokens } from "@/lib/migration/orchestrator";
import { prisma } from "@/lib/prisma";
import { finishPostmasterOAuth, isPostmasterState } from "@/lib/mail/google-postmaster-oauth";

export const dynamic = "force-dynamic";

function usersRedirect(req: NextRequest, params: Record<string, string>) {
  const origin = process.env.AUTH_URL ?? req.nextUrl.origin;
  const query = new URLSearchParams(params);
  return NextResponse.redirect(`${origin}/dashboard/users?${query.toString()}`);
}

function redirectUri(req: NextRequest) {
  const origin = process.env.AUTH_URL ?? req.nextUrl.origin;
  return `${origin}/api/migration/oauth/google/callback`;
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const oauthError = req.nextUrl.searchParams.get("error");

  if (isPostmasterState(state)) return finishPostmasterOAuth(req);

  if (oauthError) {
    return usersRedirect(req, { migrationError: oauthError });
  }

  if (!code || !state) {
    return usersRedirect(req, { migrationError: "missing_params" });
  }

  const migrationId = verifyOAuthState(state);
  if (!migrationId) {
    return usersRedirect(req, { migrationError: "invalid_state" });
  }

  try {
    const migration = await prisma.mailboxMigration.findUnique({
      where: { id: migrationId },
    });

    if (!migration || migration.provider !== "GOOGLE") {
      return usersRedirect(req, { migrationError: "not_found" });
    }

    const tokens = await exchangeGoogleCode(code, redirectUri(req));
    if (!tokens) {
      return usersRedirect(req, { migrationError: "token_exchange_failed", migrationId });
    }

    const email = tokens.email ?? migration.sourceAddress ?? migration.targetAddress;
    await storeOAuthTokens(migrationId, { ...tokens, email }, email, "google");

    return usersRedirect(req, {
      migrationId,
      migrationMailboxId: migration.mailboxId,
      migrationStep: "scope",
    });
  } catch (err) {
    if (isDbUnavailableError(err)) {
      return usersRedirect(req, { migrationError: "database_unavailable", migrationId });
    }
    console.error("[migration] google oauth callback failed:", err);
    return usersRedirect(req, { migrationError: "callback_failed", migrationId });
  }
}
