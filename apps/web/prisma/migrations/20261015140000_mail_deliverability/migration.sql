ALTER TABLE "Domain" ADD COLUMN "senderName" TEXT, ADD COLUMN "replyToAddress" TEXT;
CREATE TABLE "OutboundMessage" (
 "id" TEXT NOT NULL PRIMARY KEY, "organizationId" TEXT NOT NULL, "accountId" TEXT NOT NULL,
 "fromAddress" TEXT NOT NULL, "initiatorId" TEXT NOT NULL DEFAULT 'admin', "submissionId" TEXT, "rfcMessageId" TEXT NOT NULL,
 "subject" TEXT NOT NULL, "recipients" JSONB NOT NULL, "recipientCount" INTEGER NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'RESERVED', "deliveryJson" JSONB, "lastError" TEXT,
 "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "leaseUntil" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "OutboundMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OutboundMessage_rfcMessageId_key" ON "OutboundMessage"("rfcMessageId");
CREATE INDEX "OutboundMessage_organizationId_createdAt_idx" ON "OutboundMessage"("organizationId", "createdAt");
CREATE INDEX "OutboundMessage_status_nextCheckAt_idx" ON "OutboundMessage"("status", "nextCheckAt");
CREATE INDEX "OutboundMessage_organizationId_submissionId_idx" ON "OutboundMessage"("organizationId", "submissionId");
CREATE TABLE "MailSuppression" (
 "id" TEXT NOT NULL PRIMARY KEY, "organizationId" TEXT NOT NULL, "address" TEXT NOT NULL,
 "reason" TEXT NOT NULL, "source" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "MailSuppression_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MailSuppression_organizationId_address_key" ON "MailSuppression"("organizationId", "address");
CREATE TABLE "MailSendBudget" ("organizationId" TEXT NOT NULL PRIMARY KEY,
 CONSTRAINT "MailSendBudget_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE TABLE "MailMonitorState" ("id" TEXT NOT NULL PRIMARY KEY, "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastError" TEXT, "leaseUntil" TIMESTAMP(3));

CREATE TABLE "DmarcReport" (
 "id" TEXT NOT NULL PRIMARY KEY, "organizationId" TEXT NOT NULL, "mailboxId" TEXT NOT NULL,
 "sourceMessageId" TEXT NOT NULL, "filename" TEXT NOT NULL, "reporter" TEXT, "reportedDomain" TEXT,
 "reportIdentifier" TEXT, "periodStart" TIMESTAMP(3), "periodEnd" TIMESTAMP(3),
 "totalCount" INTEGER NOT NULL DEFAULT 0, "dkimPassCount" INTEGER NOT NULL DEFAULT 0,
 "spfPassCount" INTEGER NOT NULL DEFAULT 0, "sourcesJson" JSONB, "error" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "DmarcReport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "DmarcReport_organizationId_createdAt_idx" ON "DmarcReport"("organizationId", "createdAt");
