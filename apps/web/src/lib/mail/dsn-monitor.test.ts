import { expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/stalwart/client", () => ({}));
import { parseDsn } from "./dsn-monitor";
const report = 'Reporting-MTA: dns;mx.example.org\r\nOriginal-Envelope-Id: d96cf67c-4409-47d4-bfa2-dbac288735dd@example.org\r\n\r\nFinal-Recipient: rfc822;user@example.com\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp;550 5.1.1 User\r\n unknown\r\n\r\nFinal-Recipient: rfc822;other@example.com\r\nAction: delayed\r\nStatus: 4.2.0\r\n';
it("links a structured permanent DSN by exact envelope ID and recipient, unfolding headers", () => {
  expect(parseDsn(report)).toEqual([{ envelopeId: "d96cf67c-4409-47d4-bfa2-dbac288735dd@example.org", recipient: "user@example.com", smtpReply: "550 5.1.1 User unknown", remoteMta: "mx.example.org" }]);
  expect(parseDsn(report.replace("735dd@example.org", "735dd"))[0].envelopeId).toBe("d96cf67c-4409-47d4-bfa2-dbac288735dd");
});
it("never interprets success, delays, arbitrary text or uncorrelated reports as failures", () => {
  expect(parseDsn(report.replace("Action: failed", "Action: delivered"))).toEqual([]);
  expect(parseDsn(report.replace("Status: 5.1.1", "Status: 2.0.0"))).toEqual([]);
  expect(parseDsn(report.replace(/Original-Envelope-Id:[^\r]+\r\n/, ""))).toEqual([]);
  expect(parseDsn("Delivery failed blah blah")).toEqual([]);
  expect(parseDsn("x".repeat(256001))).toEqual([]);
});
