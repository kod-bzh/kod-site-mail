import { describe, expect, it } from "vitest";
import { aggregateDelivery, permanentAddressFailure, recipientState } from "./delivery-status";
describe("honest delivery observations", () => {
  it("does not turn SMTP acceptance into inbox delivery", () => {
    expect(recipientState({ delivered: "unknown", smtpReply: "250 2.0.0 OK" })).toBe("UNKNOWN");
    expect(recipientState({ delivered: "unknown" })).toBe("UNKNOWN");
    expect(aggregateDelivery({}, ["a@example.org"])).toBe("UNKNOWN");
  });
  it("never mistakes Stalwart's synthetic queue acknowledgement for remote acceptance", () => {
    const submitted = { delivered: "unknown", smtpReply: "250 2.1.5 Queued" };
    expect(recipientState(submitted)).toBe("UNKNOWN");
    expect(aggregateDelivery({ "a@example.org": submitted }, ["a@example.org"])).toBe("UNKNOWN");
    expect(recipientState({ ...submitted, delivered: "queued" })).toBe("QUEUED");
  });
  it("waits for all expected recipients and detects partial failures", () => {
    expect(aggregateDelivery({ "a@example.org": { delivered: "yes" } }, ["a@example.org", "b@example.org"])).toBe("UNKNOWN");
    expect(aggregateDelivery({ "a@example.org": { delivered: "yes" }, "b@example.org": { delivered: "no" } }, ["a@example.org", "b@example.org"])).toBe("PARTIAL");
  });
  it("keeps a temporary JMAP refusal unknown unless transport evidence establishes the outcome", () => {
    const temporary = { delivered: "no", smtpReply: "452 4.4.5 Rate limit exceeded, try again later." };
    expect(recipientState(temporary)).toBe("UNKNOWN");
    expect(aggregateDelivery({ "a@example.org": temporary }, ["a@example.org"])).toBe("UNKNOWN");
    expect(recipientState({ ...temporary, delivered: "queued" })).toBe("QUEUED");
    expect(recipientState({ ...temporary, source: "smtp", state: "FAILED", evidenceId: "expired" })).toBe("FAILED");
  });
  it("suppresses invalid addresses but never spam/authentication policy refusals", () => {
    expect(permanentAddressFailure({ delivered: "no", smtpReply: "550 5.1.1 User unknown" })).toBe(true);
    expect(permanentAddressFailure({ delivered: "no", smtpReply: "550 5.7.1 Spam rejected" })).toBe(false);
    expect(permanentAddressFailure({ delivered: "queued", smtpReply: "450 4.1.1 Temporary error" })).toBe(false);
    expect(permanentAddressFailure({ delivered: "no", smtpReply: "550 5.1.1 User unknown", source: "dsn", state: "BOUNCED" })).toBe(false);
    expect(permanentAddressFailure({ delivered: "no", smtpReply: "550 5.1.1 User unknown", source: "smtp", state: "FAILED" })).toBe(true);
  });
});
