/** Run only against the disposable PostgreSQL instance on port 15439. Never sends email. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (url.hostname !== "127.0.0.1" || url.port !== "15439" || url.pathname !== "/framm_test") throw Error("Disposable local database required");
  process.env.MAIL_SEND_MINUTE_LIMIT = "3";
  process.env.MAIL_SEND_DAILY_RECIPIENT_LIMIT = "4";
  const { prisma } = await import("../src/lib/prisma");
  const { reserveOutbound, MailPolicyError } = await import("../src/lib/mail/delivery");
  const orgs: string[] = [];
  try {
    for (let i = 0; i < 2; i++) orgs.push((await prisma.organization.create({ data: { name: "Disposable policy test", slug: `policy-${randomUUID()}` } })).id);
    const input = (organizationId: string, recipients = { to: ["test@example.invalid"], cc: [] as string[], bcc: [] as string[] }) => ({ organizationId, accountId: "no-smtp-called", fromAddress: "sender@example.invalid", subject: "Never sent", recipients });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => reserveOutbound(input(orgs[0]))));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 3, "Concurrent sends cannot exceed budget");
    assert.ok(results.filter(r => r.status === "rejected").every(r => r.status === "rejected" && r.reason instanceof MailPolicyError && r.reason.code === "rate_limited"));
    await reserveOutbound(input(orgs[1]));
    await prisma.mailSuppression.create({ data: { organizationId: orgs[1], address: "blocked@example.invalid", reason: "hard_bounce", source: "test" } });
    await assert.rejects(reserveOutbound(input(orgs[1], { to: ["test@example.invalid"], cc: [], bcc: ["blocked@example.invalid"] })), (e: unknown) => e instanceof MailPolicyError && e.code === "recipient_suppressed");
    assert.equal(await prisma.outboundMessage.count({ where: { organizationId: orgs[1] } }), 1, "Blocked Bcc cancels entire message");
    process.env.MAIL_SEND_MINUTE_LIMIT = "20";
    await assert.rejects(reserveOutbound(input(orgs[1], { to: ["a@example.invalid", "b@example.invalid", "c@example.invalid", "d@example.invalid"], cc: [], bcc: [] })), (e: unknown) => e instanceof MailPolicyError && e.code === "rate_limited");
    const record = await reserveOutbound(input(orgs[0], { to: ["blocked@example.invalid"], cc: [], bcc: [] }));
    assert.match(record.rfcMessageId, /@example\.invalid$/);
    console.log("PASS: real PostgreSQL locking, minute/daily limits, blocked Bcc, tenant isolation, public Message-ID");
  } finally {
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
