import { pollFeedbackReports } from "@/lib/mail/feedback";
import { pollDeliverability } from "@/lib/mail/deliverability-monitor";
import { pollDmarcReports } from "@/lib/mail/dmarc-monitor";
import { pollOutbound } from "@/lib/mail/delivery";
import { pollMailWebhooks } from "@/lib/mail/webhooks";
import { pollDsnReports } from "@/lib/mail/dsn-monitor";
import { syncPricingIfStale } from "@/lib/billing/pricing";
import { processMonthlyWalletDeductions } from "@/lib/billing/wallet";
import { prisma } from "@/lib/prisma";
import { getOrgStorageBytes } from "@/lib/storage/s3";
import { startMigrationPoller } from "@/worker/migration-worker";

const DAY_MS = 24 * 60 * 60 * 1000;

async function syncUsage() {
  const orgs = await prisma.organization.findMany({ where: { status: "APPROVED" } });
  const recordedAt = new Date();

  for (const org of orgs) {
    const storage = await getOrgStorageBytes(org.id);
    const mailboxCount = await prisma.mailbox.count({ where: { organizationId: org.id } });
    const domainCount = await prisma.domain.count({
      where: { organizationId: org.id, status: { in: ["VERIFIED", "ACTIVE"] } },
    });

    await prisma.usageSnapshot.createMany({
      data: [
        { organizationId: org.id, metric: "STORAGE_BYTES", value: storage, recordedAt },
        { organizationId: org.id, metric: "MAILBOX_COUNT", value: BigInt(mailboxCount), recordedAt },
        { organizationId: org.id, metric: "DOMAIN_COUNT", value: BigInt(domainCount), recordedAt },
      ],
    });
  }
}

async function run() {
  console.log("Framm worker started");
  await syncPricingIfStale();
  await syncUsage();
  const deducted = await processMonthlyWalletDeductions();
  if (deducted > 0) {
    console.log(`Wallet: ${deducted} monthly consumption(s) deducted`);
  }

  startMigrationPoller();
  let deliveryPolling = false;
  const checkDelivery = async () => {
    if (deliveryPolling) return;
    deliveryPolling = true;
    try {
      for (const poll of [pollOutbound, pollDsnReports, pollDmarcReports, pollFeedbackReports, pollDeliverability]) {
        try { await poll(); } catch { console.error("Mail monitoring task unavailable", poll.name); }
      }
    }
    finally { deliveryPolling = false; }
  };
  void checkDelivery();
  setInterval(() => { void checkDelivery(); }, 60_000);
  let notifying = false;
  const notify = async () => { if (notifying) return; notifying = true;
    try { await pollMailWebhooks(); } catch { console.error("Mail webhook processing unavailable"); }
    finally { notifying = false; }
  };
  void notify();
  setInterval(() => { void notify(); }, 10_000);

  setInterval(syncUsage, DAY_MS);
  setInterval(() => {
    void syncPricingIfStale();
  }, DAY_MS);
  setInterval(() => {
    void processMonthlyWalletDeductions().then((count) => {
      if (count > 0) console.log(`Wallet: ${count} monthly consumption(s) deducted`);
    });
  }, DAY_MS);
}

run();
