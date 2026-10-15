import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });
async function setup(uploadFails = false) {
  vi.stubEnv("STALWART_URL", "https://mail.example.org");
  vi.stubEnv("STALWART_API_KEY", "test-key");
  const calls: Array<[string, Record<string, unknown>, string]> = [];
  const uploads: Uint8Array[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/.well-known/jmap")) return { ok: true, json: async () => ({ uploadUrl: "https://mail.example.org/jmap/upload/{accountId}/" }) };
    if (url.includes("/upload/")) { uploads.push(init!.body as Uint8Array); return { ok: !uploadFails, status: 500, json: async () => ({ blobId: "pdf-blob" }) }; }
    const methods = JSON.parse(init!.body as string).methodCalls;
    calls.push(...methods);
    return { ok: true, json: async () => ({ methodResponses: methods.map(([name]: [string]) => [name,
      name === "Mailbox/get" ? { list: [{ id: "drafts" }] } :
      name === "Identity/get" ? { list: [{ id: "identity", email: "sender@example.org" }] } :
      name === "Email/set" ? { created: { e1: { id: "email" } } } :
      name === "EmailSubmission/set" ? { created: { s1: { id: "submission" } } } : { ids: ["drafts"] }
    ]) }) };
  }));
  const { sendMailViaStalwartJmap } = await import("./client");
  return { send: sendMailViaStalwartJmap, calls, uploads };
}
const base = { accountId: "account", from: "sender@example.org", to: "to@example.com", subject: "Test", text: "Body" };
describe("Stalwart outbound message", () => {
  it.each(["cc", "bcc"] as const)("sends with %s only as a copy", async (field) => {
    const { send, calls } = await setup();
    expect(await send({ ...base, [field]: "copy@example.com" })).toMatchObject({ ok: true, messageId: "submission" });
    const email = (calls.find(c => c[0] === "Email/set")![1].create as Record<string, Record<string, unknown>>).e1;
    expect(email.to).toEqual([{ email: "to@example.com" }]);
    expect(email.bcc).toBeUndefined();
    if (field === "cc") expect(email.cc).toEqual([{ email: "copy@example.com" }]);
    else expect(JSON.stringify(email)).not.toContain("copy@example.com");
    const submission = (calls.find(c => c[0] === "EmailSubmission/set")![1].create as Record<string, Record<string, unknown>>).s1;
    expect(submission.envelope).toEqual({ mailFrom: { email: "sender@example.org" }, rcptTo: [{ email: "to@example.com" }, { email: "copy@example.com" }] });
  });
  it("uploads the exact PDF bytes and builds mixed MIME with the body first", async () => {
    const { send, calls, uploads } = await setup();
    const pdf = Buffer.from("%PDF-1.4\n%%EOF");
    expect(await send({ ...base, html: "<p>Body</p>", attachments: [{ filename: "document.pdf", content: pdf.toString("base64"), contentType: "application/pdf" }] })).toMatchObject({ ok: true });
    expect(Buffer.from(uploads[0])).toEqual(pdf);
    const email = (calls.find(c => c[0] === "Email/set")![1].create as Record<string, Record<string, unknown>>).e1;
    expect(email.bodyStructure).toEqual({ type: "multipart/mixed", subParts: [{ type: "multipart/alternative", subParts: [{ partId: "text", type: "text/plain" }, { partId: "html", type: "text/html" }] }, { blobId: "pdf-blob", type: "application/pdf", name: "document.pdf", disposition: "attachment" }] });
  });
  it("does not create or submit a message if an upload fails", async () => {
    const { send, calls } = await setup(true);
    expect(await send({ ...base, attachments: [{ filename: "document.pdf", content: "YQ==" }] })).toMatchObject({ ok: false, detail: expect.stringContaining("document.pdf") });
    expect(calls.some(c => c[0] === "EmailSubmission/set" || c[0] === "Email/set")).toBe(false);
  });
  it("still sends the legacy payload", async () => {
    const { send } = await setup();
    expect(await send(base)).toMatchObject({ ok: true, messageId: "submission" });
  });
});
