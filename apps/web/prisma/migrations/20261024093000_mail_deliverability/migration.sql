-- AlterTable
ALTER TABLE "OutboundMessage" ADD COLUMN     "readReceiptAddress" TEXT,
ADD COLUMN     "requestReadReceipt" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MailWebhook" ADD COLUMN     "allowedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "eventTypes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "MailWebhookAttempt" ADD COLUMN     "telemetryEventId" TEXT,
ALTER COLUMN "eventId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "OrganizationApiKey" ADD COLUMN     "allowedMailDomains" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "DmarcReport" ADD COLUMN     "intakeEvidence" JSONB,
ADD COLUMN     "provenance" TEXT NOT NULL DEFAULT 'unverified_report',
ADD COLUMN     "semanticKey" TEXT,
ADD COLUMN     "sourceReceivedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MailConnector" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'not_configured',
    "secretCipher" TEXT,
    "settings" JSONB,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "expiresAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),

    CONSTRAINT "MailConnector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailObservation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'domain',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB NOT NULL,

    CONSTRAINT "MailObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailIncident" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "summary" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "generation" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "MailIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailTelemetryEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "messageId" TEXT,
    "recipient" TEXT,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reliability" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB NOT NULL,

    CONSTRAINT "MailTelemetryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailMonitoredDomain" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "authorizationSource" TEXT NOT NULL,

    CONSTRAINT "MailMonitoredDomain_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailConnector_nextCheckAt_idx" ON "MailConnector"("nextCheckAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailConnector_organizationId_domain_provider_key" ON "MailConnector"("organizationId", "domain", "provider");

-- CreateIndex
CREATE INDEX "MailObservation_organizationId_domain_provider_periodEnd_idx" ON "MailObservation"("organizationId", "domain", "provider", "periodEnd");

-- CreateIndex
CREATE INDEX "MailIncident_organizationId_status_observedAt_idx" ON "MailIncident"("organizationId", "status", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailIncident_organizationId_fingerprint_key" ON "MailIncident"("organizationId", "fingerprint");

-- CreateIndex
CREATE INDEX "MailTelemetryEvent_organizationId_domain_receivedAt_id_idx" ON "MailTelemetryEvent"("organizationId", "domain", "receivedAt", "id");

-- CreateIndex
CREATE INDEX "MailTelemetryEvent_messageId_occurredAt_idx" ON "MailTelemetryEvent"("messageId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailMonitoredDomain_domain_key" ON "MailMonitoredDomain"("domain");

-- CreateIndex
CREATE INDEX "MailMonitoredDomain_organizationId_idx" ON "MailMonitoredDomain"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_id_organizationId_key" ON "OutboundMessage"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "MailWebhookAttempt_webhookId_telemetryEventId_key" ON "MailWebhookAttempt"("webhookId", "telemetryEventId");

-- CreateIndex
CREATE UNIQUE INDEX "DmarcReport_semanticKey_key" ON "DmarcReport"("semanticKey");

-- AddForeignKey
ALTER TABLE "MailWebhookAttempt" ADD CONSTRAINT "MailWebhookAttempt_telemetryEventId_fkey" FOREIGN KEY ("telemetryEventId") REFERENCES "MailTelemetryEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailConnector" ADD CONSTRAINT "MailConnector_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailObservation" ADD CONSTRAINT "MailObservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailIncident" ADD CONSTRAINT "MailIncident_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailTelemetryEvent" ADD CONSTRAINT "MailTelemetryEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailTelemetryEvent" ADD CONSTRAINT "MailTelemetryEvent_messageId_organizationId_fkey" FOREIGN KEY ("messageId", "organizationId") REFERENCES "OutboundMessage"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMonitoredDomain" ADD CONSTRAINT "MailMonitoredDomain_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "MailWebhookAttempt" ADD CONSTRAINT "MailWebhookAttempt_one_event_check"
CHECK (("eventId" IS NOT NULL)::int + ("telemetryEventId" IS NOT NULL)::int = 1);
