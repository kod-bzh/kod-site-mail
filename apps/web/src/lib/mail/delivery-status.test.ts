import { describe, expect, it } from "vitest";
import { aggregateDelivery, permanentAddressFailure, recipientState } from "./delivery-status";
describe("honest delivery observations", () => {
  it("does not turn SMTP acceptance into inbox delivery", () => {
    expect(recipientState({ delivered: "unknown", smtpReply: "250 2.0.0 OK" })).toBe("ACCEPTED");
    expect(recipientState({ delivered: "unknown" })).toBe("UNKNOWN");
    expect(aggregateDelivery({}, ["a@example.org"])).toBe("UNKNOWN");
  });
  it("waits for all expected recipients and detects partial failures", () => {
    expect(aggregateDelivery({ "a@example.org": { delivered: "yes" } }, ["a@example.org", "b@example.org"])).toBe("UNKNOWN");
    expect(aggregateDelivery({ "a@example.org": { delivered: "yes" }, "b@example.org": { delivered: "no" } }, ["a@example.org", "b@example.org"])).toBe("PARTIAL");
  });
  it("suppresses invalid addresses but never spam/authentication policy refusals", () => {
    expect(permanentAddressFailure({ delivered: "no", smtpReply: "550 5.1.1 User unknown" })).toBe(true);
    expect(permanentAddressFailure({ delivered: "no", smtpReply: "550 5.7.1 Spam rejected" })).toBe(false);
    expect(permanentAddressFailure({ delivered: "queued", smtpReply: "450 4.1.1 Temporary error" })).toBe(false);
  });
});
