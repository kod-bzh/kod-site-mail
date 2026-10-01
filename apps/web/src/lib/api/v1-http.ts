import { NextResponse } from "next/server";
import type { V1Actor } from "@/lib/api/v1-auth";
import { actorHasScope, resolveV1ActorFromRequest } from "@/lib/api/v1-auth";

const ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_body: 400,
  invalid_fqdn: 400,
  invalid_local_part: 400,
  invalid_arguments: 400,
  organization_required: 400,
  organization_not_found: 404,
  organization_forbidden: 403,
  domain_not_found: 404,
  domain_taken: 409,
  exists: 409,
  exists_as_alias: 409,
  password_weak: 400,
  stalwart_unavailable: 503,
  domain_not_synced: 503,
  stalwart_error: 502,
};

export function v1Error(error: string, extra?: Record<string, unknown>) {
  return NextResponse.json(
    { error, ...extra },
    { status: ERROR_STATUS[error] ?? 400 }
  );
}

export async function requireV1Actor(req: Request, scope?: string | string[]) {
  const actor = await resolveV1ActorFromRequest(req);
  if (!actor) return { actor: null, error: v1Error("unauthorized") };
  const scopes = scope ? (Array.isArray(scope) ? scope : [scope]) : [];
  if (scopes.length > 0 && !scopes.some((item) => actorHasScope(actor, item))) {
    return { actor: null, error: v1Error("forbidden") };
  }
  return { actor, error: null };
}

export function readOrgSlug(req: Request, body?: { organizationSlug?: string }) {
  return (
    body?.organizationSlug ??
    new URL(req.url).searchParams.get("organizationSlug") ??
    req.headers.get("x-framm-organization") ??
    undefined
  );
}

export function jsonOk(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export type { V1Actor };
