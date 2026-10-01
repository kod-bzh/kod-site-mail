"use server";

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  clientRedirectWithParams,
  findOAuthClient,
  issueAuthorizationCode,
  parseAuthorizeRequest,
  redirectUriAllowed,
} from "@/lib/mcp/oauth";

function readAuthorizeForm(formData: FormData) {
  return parseAuthorizeRequest({
    get: (name) => {
      const value = formData.get(name);
      return typeof value === "string" ? value : null;
    },
  });
}

export async function approveMcpOAuthAction(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const parsed = readAuthorizeForm(formData);
  if ("error" in parsed) {
    redirect("/oauth/authorize?error=invalid_request");
  }

  const client = await findOAuthClient(parsed.clientId);
  if (!client || !redirectUriAllowed(client.redirectUris, parsed.redirectUri)) {
    redirect("/oauth/authorize?error=invalid_request");
  }

  const code = await issueAuthorizationCode({
    clientId: parsed.clientId,
    redirectUri: parsed.redirectUri,
    codeChallenge: parsed.codeChallenge,
    codeChallengeMethod: parsed.codeChallengeMethod,
    state: parsed.state,
    resource: parsed.resource,
    userId: session.user.id,
  });

  redirect(
    clientRedirectWithParams(parsed.redirectUri, {
      code,
      ...(parsed.state ? { state: parsed.state } : {}),
    })
  );
}

export async function denyMcpOAuthAction(formData: FormData) {
  const parsed = readAuthorizeForm(formData);
  if ("error" in parsed) {
    redirect("/oauth/authorize?error=invalid_request");
  }
  const client = await findOAuthClient(parsed.clientId);
  if (!client || !redirectUriAllowed(client.redirectUris, parsed.redirectUri)) {
    redirect("/oauth/authorize?error=invalid_request");
  }
  redirect(
    clientRedirectWithParams(parsed.redirectUri, {
      error: "access_denied",
      ...(parsed.state ? { state: parsed.state } : {}),
    })
  );
}
