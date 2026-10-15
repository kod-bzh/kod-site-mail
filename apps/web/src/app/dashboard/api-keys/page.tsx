import { unstable_noStore as noStore } from "next/cache";
import { getOrgId, requireOrgAdmin } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { ApiKeysCrud } from "@/components/api-keys/api-keys-crud";
import { getT } from "@/i18n/t";

export const dynamic = "force-dynamic";

function resolvePublicApiBaseUrl(): string {
  const authUrl = process.env.AUTH_URL?.replace(/\/$/, "");
  if (authUrl) return authUrl;
  return "https://kod.bzh";
}

export default async function ApiKeysPage() {
  noStore();
  const session = await requireOrgAdmin();
  const orgId = getOrgId(session)!;
  const t = await getT("apiKeys");

  const keys = await prisma.organizationApiKey.findMany({
    where: { organizationId: orgId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      scopes: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });

  const verifiedDomains = await prisma.domain.findMany({
    where: {
      organizationId: orgId,
      status: { in: ["VERIFIED", "ACTIVE"] },
    },
    select: { fqdn: true },
    orderBy: { fqdn: "asc" },
  });

  return (
    <ApiKeysCrud
      keys={keys.map((key) => ({
        ...key,
        lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
        createdAt: key.createdAt.toISOString(),
      }))}
      verifiedDomains={verifiedDomains.map((d) => d.fqdn)}
      apiBaseUrl={resolvePublicApiBaseUrl()}
      labels={{
        title: t("title"),
        intro: t("intro"),
        create: t("create"),
        creating: t("creating"),
        name: t("name"),
        namePlaceholder: t("namePlaceholder"),
        colName: t("colName"),
        colPrefix: t("colPrefix"),
        colScopes: t("colScopes"),
        colLastUsed: t("colLastUsed"),
        colCreated: t("colCreated"),
        revoke: t("revoke"),
        revoking: t("revoking"),
        neverUsed: t("neverUsed"),
        scopeMailSend: t("scopeMailSend"),
        tokenRevealTitle: t("tokenRevealTitle"),
        tokenRevealHint: t("tokenRevealHint"),
        copy: t("copy"),
        copied: t("copied"),
        curlTitle: t("curlTitle"),
        curlHint: t("curlHint"),
        verifiedDomainsTitle: t("verifiedDomainsTitle"),
        verifiedDomainsEmpty: t("verifiedDomainsEmpty"),
        endpointLabel: t("endpointLabel"),
      }}
    />
  );
}
