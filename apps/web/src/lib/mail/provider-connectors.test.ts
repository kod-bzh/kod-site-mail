import { describe, it, expect } from "vitest";
import { approvedSndsUrl, normalizeGoogle, connectorPublic, parseCsv } from "./provider-connectors";
import type { MailConnector } from "@prisma/client";
import { classifySource } from "./source-inventory";
import { recipientProvider } from "./smtp-metrics";
describe("honest provider observations", () => {
  it("preserves missing metrics as null and explicit reported zero as zero", () => {
    const empty = normalizeGoogle({}); expect(empty.domainReputation).toBeNull();
    expect(empty.userReportedSpamRatio).toMatchObject({ value: null, numerator: null, denominator: null });
    expect(normalizeGoogle({ userReportedSpamRatio: 0 }).userReportedSpamRatio).toMatchObject({ value: 0, denominator: null });
  });
  it("never exposes another IP in a provider sample or a guessed count", () => {
    expect(normalizeGoogle({ ipReputations: [{ reputation: "BAD", sampleIps: ["192.0.2.1"], ipCount: "44" }, { reputation: "HIGH", sampleIps: ["51.15.220.2", "192.0.2.2"] }] }).ipReputation)
      .toEqual([{ ip: "51.15.220.2", reputation: "HIGH" }]);
  });
  it("reports missing authorization, expired access and stale data distinctly", () => {
    expect(connectorPublic(null, "google_postmaster")).toMatchObject({ state: "not_configured", lastSuccessfulCollectionAt: null });
    const connector = { state: "active", lastSuccessAt: new Date(0) } as MailConnector;
    expect(connectorPublic(connector, "google_postmaster")).toMatchObject({ state: "stale" });
    expect(connectorPublic({ ...connector, expiresAt: new Date(0) }, "google_postmaster")).toMatchObject({ state: "authorization_required" });
  });
  it("only allows current official SNDS feed hosts, never credentials or redirect hosts", () => {
    expect(approvedSndsUrl("https://substrate.office.com/ip-domain-management-snds/export?key=secret")).toContain("substrate.office.com");
    for (const value of ["http://substrate.office.com/ip-domain-management-snds/export", "https://evil.test/export", "https://a:b@substrate.office.com/ip-domain-management-snds/export", "https://substrate.office.com/other", "https://substrate.office.com.evil.test/ip-domain-management-snds/"]) expect(() => approvedSndsUrl(value)).toThrow();
  });
  it("parses CSV quoting and rejects incomplete and oversized fields", () => {
    expect(parseCsv('IP,Date,State\r\n"51.15.220.2","2026-10-24","green"\r\n')).toEqual([["IP", "Date", "State"], ["51.15.220.2", "2026-10-24", "green"]]);
    expect(() => parseCsv('"unfinished')).toThrow(); expect(() => parseCsv("x".repeat(10001))).toThrow();
  });
  it("only classifies Microsoft 365 by an explicit documented inventory", () => {
    expect(classifySource("51.15.220.2", []).kind).toBe("kod"); expect(classifySource("192.0.2.1", []).kind).toBe("unknown");
    expect(classifySource("192.0.2.1", [{ cidr: "192.0.2.0/24", kind: "microsoft365", label: "Example approved fixture" }]).kind).toBe("microsoft365");
    expect(recipientProvider("user@example.org", "mx.protection.outlook.com")).toBe("microsoft365");
    expect(recipientProvider("user@outlook.com")).toBe("outlook_consumer");
    expect(recipientProvider("user@example.org", "protection.outlook.com.evil.test")).toBe("other_or_unknown");
  });
});
