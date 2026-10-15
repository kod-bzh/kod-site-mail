import { unstable_noStore as noStore } from "next/cache";
import { getOrgId, requireOrgAdmin } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { DomainsCrud } from "@/components/domains/domains-crud";
import { getT } from "@/i18n/t";
import { StalwartStatusBanner } from "@/components/stalwart/status-banner";
import {
  getPlatformMailHost,
  isPlatformDomain,
} from "@/lib/dns/dns-records";
import { registrarDnsRecords } from "@/lib/domains/manage";
import { verifyDomainDns } from "@/lib/dns/verify";

export const dynamic = "force-dynamic";

export default async function DomainsPage() {
  noStore();
  const session = await requireOrgAdmin();
  const orgId = getOrgId(session)!;
  const t = await getT("domains");
  const platformHost = getPlatformMailHost();

  const domains = await prisma.domain.findMany({
    where: { organizationId: orgId },
    orderBy: { createdAt: "desc" },
  });

  const domainCards = await Promise.all(
    domains.map(async (domain) => {
      const isPlatform = isPlatformDomain(domain.fqdn);
      const records = await registrarDnsRecords(domain.fqdn, platformHost);
      const dnsCheck = await verifyDomainDns(domain.fqdn, platformHost);
      const isVerified = dnsCheck.verified;

      return {
        id: domain.id,
        fqdn: domain.fqdn,
        isVerified,
        isPlatform,
        records,
        dnsCheck,
      };
    })
  );

  const tableLabels = {
    colType: t("colType"),
    colHost: t("colHost"),
    colPriority: t("colPriority"),
    colValue: t("colValue"),
    copy: t("copy"),
    copied: t("copied"),
    hostRootHint: t("hostRootHint"),
    srvValueHint: t("srvValueHint"),
  };

  const listLabels = {
    statusVerified: t("statusVerified"),
    statusPending: t("statusPending"),
    verified: t("verified"),
    pending: t("pending"),
    usableWhilePending: t("usableWhilePending"),
    records: t("records"),
    recordsIntro: t("recordsIntro", { mailHost: platformHost }),
    recordsAutoconfigHint: t("recordsAutoconfigHint"),
  };

  return (
    <div className="space-y-6">
      <StalwartStatusBanner namespace="domains" />
      <DomainsCrud
        domains={domainCards}
        labels={listLabels}
        tableLabels={tableLabels}
        mailHost={platformHost}
      />
    </div>
  );
}
