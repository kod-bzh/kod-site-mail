-- Run only on an ephemeral PostgreSQL test database, never the production database.
DO $$ BEGIN IF current_database() NOT LIKE 'kodtest%' THEN RAISE EXCEPTION 'Ephemeral test database required'; END IF; END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='MailWebhookAttempt_one_event_check' AND conrelid='"MailWebhookAttempt"'::regclass) THEN RAISE EXCEPTION 'Required outbox migration constraint missing'; END IF;
END $$;
INSERT INTO "Organization" (id,name,slug,"updatedAt") VALUES ('fixture-a','Simulated A','fixture-a',now()),('fixture-b','Simulated B','fixture-b',now());
INSERT INTO "OutboundMessage" (id,"organizationId","accountId","fromAddress",subject,recipients,"recipientCount","rfcMessageId","updatedAt") VALUES
('message-a','fixture-a','account-a','sender@example.org','Simulated','{"to":["recipient@example.net"],"cc":[],"bcc":[]}',1,'rfc-a@example.org',now()),
('message-b','fixture-b','account-b','sender@other.example','Simulated','{"to":["recipient@example.net"],"cc":[],"bcc":[]}',1,'rfc-b@other.example',now());
INSERT INTO "MailTelemetryEvent" (id,"organizationId",domain,"messageId",type,source,reliability,"occurredAt",data) VALUES
('stable-event','fixture-a','example.org','message-a','email.mdn','fixture','unverified_report',now(),'{}');
INSERT INTO "MailTelemetryEvent" (id,"organizationId",domain,"messageId",type,source,reliability,"occurredAt",data) VALUES
('stable-event','fixture-a','example.org','message-a','email.mdn','fixture','unverified_report',now(),'{}') ON CONFLICT DO NOTHING;
DO $$ BEGIN
 IF (SELECT count(*) FROM "MailTelemetryEvent" WHERE id='stable-event')<>1 THEN RAISE EXCEPTION 'Deduplication failed'; END IF;
 BEGIN
  INSERT INTO "MailTelemetryEvent" (id,"organizationId",domain,"messageId",type,source,reliability,"occurredAt",data) VALUES ('cross-tenant','fixture-a','example.org','message-b','email.mdn','fixture','unverified_report',now(),'{}');
  RAISE EXCEPTION 'Cross-tenant message correlation was accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
END $$;
INSERT INTO "MailWebhook" (id,"organizationId","initiatorId",url,"secretCipher") VALUES ('hook-a','fixture-a','key-a','https://example.net/hook','fixture-no-secret');
INSERT INTO "MailWebhookAttempt" (id,"webhookId","telemetryEventId") VALUES ('attempt-a','hook-a','stable-event');
INSERT INTO "MailWebhookAttempt" (id,"webhookId","telemetryEventId") VALUES ('attempt-duplicate','hook-a','stable-event') ON CONFLICT DO NOTHING;
DO $$ BEGIN
 IF (SELECT count(*) FROM "MailWebhookAttempt" WHERE "telemetryEventId"='stable-event')<>1 THEN RAISE EXCEPTION 'Outbox deduplication failed'; END IF;
 BEGIN
  INSERT INTO "MailWebhookAttempt" (id,"webhookId") VALUES ('invalid-empty-attempt','hook-a');
  RAISE EXCEPTION 'Empty event reference accepted';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
END $$;
INSERT INTO "MailIncident" (id,"organizationId",domain,fingerprint,code,severity,summary,action,evidence) VALUES
('incident-a','fixture-a','example.org','same-fingerprint','fixture','warning','Simulated','Review','{}'),
('incident-b','fixture-b','other.example','same-fingerprint','fixture','warning','Simulated','Review','{}');
DO $$ BEGIN
 IF (SELECT count(*) FROM "MailIncident" WHERE "organizationId"='fixture-a')<>1 THEN RAISE EXCEPTION 'Tenant isolation failed'; END IF;
END $$;
SELECT 'PASS: semantic event and outbox deduplication; cross-tenant correlation rejected; exactly-one-event constraint; tenant isolation' AS result;
