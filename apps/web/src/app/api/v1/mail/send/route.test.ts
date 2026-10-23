import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ send: vi.fn(), audit: vi.fn(), key: vi.fn() }));
vi.mock("@/lib/api-keys", () => ({ hasScope: () => true, MAIL_SEND_SCOPE: "mail:send", verifyBearerApiKey: mocks.key }));
vi.mock("@/lib/api/v1-auth", () => ({ resolveV1ActorFromRequest: vi.fn() }));
vi.mock("@/lib/mail/admin-send", () => ({ verifyAdminMailToken: () => false, sendAdminMail: vi.fn() }));
vi.mock("@/lib/mail/org-mail-send", () => ({ sendOrgMail: mocks.send, findOrganizationIdByFromAddress: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { auditLog: { create: mocks.audit } } }));
import { POST } from "./route";
import { UploadedAttachment } from "@/lib/mail/uploaded-attachment";
const base = { from: "sender@example.org", to: "to@example.com", subject: "Test", text: "Body" };
function request(body: unknown) { return new NextRequest("https://kod.bzh/api/v1/mail/send", { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
beforeEach(() => { vi.clearAllMocks(); mocks.key.mockResolvedValue({ id: "key", organizationId: "org", scopes: ["mail:send"] }); mocks.send.mockResolvedValue({ ok: true, messageId: "submission" }); mocks.audit.mockResolvedValue({}); });
describe("POST mail/send compatibility", () => {
  it.each([
    ["legacy", {}], ["cc", { cc: "cc@example.com" }], ["bcc", { bcc: ["bcc@example.com"] }],
    ["PDF", { attachments: [{ filename: "document.pdf", content: Buffer.from("%PDF-1.4\n%%EOF").toString("base64"), contentType: "application/pdf" }] }],
  ])("accepts %s and preserves the success contract", async (_, extra) => {
    const response = await POST(request({ ...base, ...extra }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, messageId: "submission" });
    expect(mocks.send).toHaveBeenCalledWith({ organizationId: "org", initiatorId: "key", ...base, ...extra });
  });
  it("rejects an unreadable file before sending anything", async () => {
    const response = await POST(request({ ...base, attachments: [{ filename: "bad.pdf", content: "%%%" }] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_attachments", detail: expect.stringContaining("bad.pdf") });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("rejects an empty filename with its indexed field", async () => {
    const response = await POST(request({ ...base, attachments: [{ filename: "", content: "YQ==" }] }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ detail: expect.stringContaining("attachments.0.filename") });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each([true, false])("handles multipart success=%s and cleans files after sending or policy refusal", async success => {
    const form = new FormData();
    for (const [name, value] of Object.entries(base)) form.append(name, value);
    const bytes = Buffer.from([0, 255, 13, 10, 128]);
    form.append("attachments", new Blob([bytes], { type: "application/pdf" }), "document.pdf");
    let file: UploadedAttachment;
    mocks.send.mockImplementationOnce(async input => {
      file = input.attachments[0];
      expect(file).toBeInstanceOf(UploadedAttachment);
      const chunks = []; for await (const chunk of file.open()) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(bytes);
      return success ? { ok: true, messageId: "submission" } : { ok: false, error: "domain_not_in_org" };
    });
    const response = await POST(new NextRequest("https://kod.bzh/api/v1/mail/send", { method: "POST", headers: { Authorization: "Bearer test" }, body: form }));
    expect(response.status).toBe(success ? 200 : 403);
    const readDeletedFile = async () => { for await (const chunk of file!.open()) void chunk; };
    await expect(readDeletedFile()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("authenticates before consuming a multipart upload", async () => {
    mocks.key.mockResolvedValueOnce(null);
    const form = new FormData(); form.append("attachments", new Blob(["private"]), "private.txt");
    const req = new NextRequest("https://kod.bzh/api/v1/mail/send", { method: "POST", body: form });
    expect((await POST(req)).status).toBe(401);
    expect(req.bodyUsed).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
