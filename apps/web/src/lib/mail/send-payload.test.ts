import { describe, expect, it } from "vitest";
import { decodeAttachments, MAX_ATTACHMENT_BYTES, normalizeMailRecipients } from "./send-payload";

describe("mail payload", () => {
  it("deduplicates with To > Cc > Bcc priority", () => {
    expect(normalizeMailRecipients({ to: ["A@example.com", "a@example.com"], cc: ["a@example.com", "b@example.com"], bcc: ["B@example.com", "c@example.com"] })).toEqual({ to: ["a@example.com"], cc: ["b@example.com"], bcc: ["c@example.com"] });
  });
  it("rejects malformed base64 and reports the file", () => {
    expect(() => decodeAttachments([{ filename: "broken.pdf", content: "%%%" }])).toThrow(/broken.pdf.*base64/);
  });
  it("rejects empty filenames", () => {
    expect(() => decodeAttachments([{ filename: " ", content: "YQ==" }])).toThrow(/attachments\[0\]/);
  });
  it("accepts exactly 50 MB and rejects a cumulative overflow", () => {
    const file = { filename: "large.bin", content: Buffer.alloc(MAX_ATTACHMENT_BYTES).toString("base64") };
    expect(decodeAttachments([file])[0].content.length).toBe(MAX_ATTACHMENT_BYTES);
    expect(() => decodeAttachments([file, { filename: "extra.bin", content: "YQ==" }])).toThrow(/extra.bin.*50 Mo/);
  });
  it("defaults the MIME type and rejects header injection", () => {
    expect(decodeAttachments([{ filename: "file", content: "YQ==" }])[0].contentType).toBe("application/octet-stream");
    expect(() => decodeAttachments([{ filename: "file\r\nBcc: x", content: "YQ==" }])).toThrow();
  });
});
