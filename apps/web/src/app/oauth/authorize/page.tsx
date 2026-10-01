import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { approveMcpOAuthAction, denyMcpOAuthAction } from "@/app/actions/mcp-oauth";
import { BrandLogo } from "@/components/layout/brand-logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { actorFromUserId, findOAuthClient, parseAuthorizeRequest, redirectUriAllowed } from "@/lib/mcp/oauth";
import { getT } from "@/i18n/t";

export const dynamic = "force-dynamic";

export default async function OAuthAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getT("oauth");
  const tc = await getT("common");
  const params = await searchParams;
  const queryError = typeof params.error === "string" ? params.error : "";

  const parsed = parseAuthorizeRequest({
    get: (name) => {
      const value = params[name];
      return typeof value === "string" ? value : null;
    },
  });

  if ("error" in parsed) {
    return (
      <AuthorizeShell title={t("title")} appName={tc("appName")}>
        <p className="text-sm text-red-600">{authorizeErrorMessage(t, parsed.error)}</p>
      </AuthorizeShell>
    );
  }

  const client = await findOAuthClient(parsed.clientId);
  if (!client || !redirectUriAllowed(client.redirectUris, parsed.redirectUri)) {
    return (
      <AuthorizeShell title={t("title")} appName={tc("appName")}>
        <p className="text-sm text-red-600">{t("unknownClient")}</p>
      </AuthorizeShell>
    );
  }

  const session = await auth();
  if (!session?.user?.id) {
    const returnTo = `/oauth/authorize?${new URLSearchParams({
      client_id: parsed.clientId,
      redirect_uri: parsed.redirectUri,
      response_type: parsed.responseType,
      code_challenge: parsed.codeChallenge,
      code_challenge_method: parsed.codeChallengeMethod,
      state: parsed.state,
      ...(parsed.resource ? { resource: parsed.resource } : {}),
    }).toString()}`;
    redirect(`/login?callbackUrl=${encodeURIComponent(returnTo)}`);
  }

  const actor = await actorFromUserId(session.user.id);
  const scopes = actor?.scopes ?? [];

  const hidden = (
    <>
      <input type="hidden" name="client_id" value={parsed.clientId} />
      <input type="hidden" name="redirect_uri" value={parsed.redirectUri} />
      <input type="hidden" name="response_type" value={parsed.responseType} />
      <input type="hidden" name="code_challenge" value={parsed.codeChallenge} />
      <input type="hidden" name="code_challenge_method" value={parsed.codeChallengeMethod} />
      <input type="hidden" name="state" value={parsed.state} />
      {parsed.resource ? <input type="hidden" name="resource" value={parsed.resource} /> : null}
    </>
  );

  return (
    <AuthorizeShell title={t("title")} appName={tc("appName")}>
      {queryError ? <p className="mb-4 text-sm text-red-600">{authorizeErrorMessage(t, queryError)}</p> : null}
      <p className="text-sm text-ardoise">
        {t("intro", { client: client.clientName, email: session.user.email })}
      </p>
      <dl className="mt-4 space-y-2 text-sm">
        <div>
          <dt className="text-ardoise/60">{t("clientLabel")}</dt>
          <dd className="font-medium">{client.clientName}</dd>
        </div>
        <div>
          <dt className="text-ardoise/60">{t("accountLabel")}</dt>
          <dd className="font-medium">{session.user.email}</dd>
        </div>
      </dl>
      <p className="mt-4 text-sm font-medium">{t("scopesLabel")}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ardoise">
        {scopes.map((scope) => (
          <li key={scope}>{scopeLabel(t, scope)}</li>
        ))}
      </ul>
      {actor?.isAdmin ? <p className="mt-3 text-sm text-ardoise/80">{t("adminHint")}</p> : null}
      <div className="mt-6 flex gap-3">
        <form action={denyMcpOAuthAction} className="flex-1">
          {hidden}
          <Button type="submit" variant="outline" className="w-full">
            {t("deny")}
          </Button>
        </form>
        <form action={approveMcpOAuthAction} className="flex-1">
          {hidden}
          <Button type="submit" className="w-full">
            {t("approve")}
          </Button>
        </form>
      </div>
    </AuthorizeShell>
  );
}

type OAuthMessage = (
  key:
    | "invalidRequest"
    | "unknownClient"
    | "invalidRedirect"
    | "pkceRequired"
    | "accessDenied"
    | "scopeMailSend"
    | "scopeDomainsRead"
    | "scopeDomainsWrite"
    | "scopeApiKeysWrite"
    | "scopeMailboxesWrite"
) => string;

function authorizeErrorMessage(t: OAuthMessage, error: string) {
  if (error === "unknown_client" || error === "unknownClient") return t("unknownClient");
  if (error === "invalid_redirect" || error === "invalidRedirect") return t("invalidRedirect");
  if (error === "pkce_required" || error === "pkceRequired") return t("pkceRequired");
  if (error === "access_denied") return t("accessDenied");
  return t("invalidRequest");
}

function scopeLabel(t: OAuthMessage, scope: string) {
  if (scope === "mail:send") return t("scopeMailSend");
  if (scope === "domains:read") return t("scopeDomainsRead");
  if (scope === "domains:write") return t("scopeDomainsWrite");
  if (scope === "api_keys:write") return t("scopeApiKeysWrite");
  if (scope === "mailboxes:write") return t("scopeMailboxesWrite");
  return scope;
}

function AuthorizeShell({
  title,
  appName,
  children,
}: {
  title: string;
  appName: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="mb-8">
        <BrandLogo alt={appName} href="/" size="sm" />
      </div>
      <Card className="w-full max-w-md border-canal shadow-none">
        <CardHeader className="border-0 pb-0 text-center">
          <CardTitle className="text-base font-semibold">{title}</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">{children}</CardContent>
      </Card>
    </div>
  );
}
