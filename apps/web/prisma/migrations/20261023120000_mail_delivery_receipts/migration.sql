-- CreateTable
CREATE TABLE "MailDeliveryEvent" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailDeliveryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailWebhook" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secretCipher" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailWebhookAttempt" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttempt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastStatus" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailWebhookAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailDeliveryEvent_messageId_occurredAt_idx" ON "MailDeliveryEvent"("messageId", "occurredAt");

-- CreateIndex
CREATE INDEX "MailWebhook_organizationId_initiatorId_idx" ON "MailWebhook"("organizationId", "initiatorId");

-- CreateIndex
CREATE INDEX "MailWebhookAttempt_completedAt_nextAttempt_idx" ON "MailWebhookAttempt"("completedAt", "nextAttempt");

-- CreateIndex
CREATE UNIQUE INDEX "MailWebhookAttempt_webhookId_eventId_key" ON "MailWebhookAttempt"("webhookId", "eventId");

-- AddForeignKey
ALTER TABLE "MailDeliveryEvent" ADD CONSTRAINT "MailDeliveryEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "OutboundMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailWebhook" ADD CONSTRAINT "MailWebhook_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailWebhookAttempt" ADD CONSTRAINT "MailWebhookAttempt_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "MailWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailWebhookAttempt" ADD CONSTRAINT "MailWebhookAttempt_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "MailDeliveryEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
