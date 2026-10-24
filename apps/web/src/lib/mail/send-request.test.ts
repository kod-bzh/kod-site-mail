import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { parseMailSendRequest } from "./send-request";
import { MAX_ATTACHMENT_BYTES } from "./send-payload";
import { UploadedAttachment } from "./uploaded-attachment";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "kod-parser-test-")); vi.stubEnv("TMPDIR", directory); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const fields = { from: "sender@example.org", to: "to@example.com", subject: "Document", text: "Corps du message" };
function request(inputFields: Record<string, string | readonly string[]> = fields, files: { name?: string; filename?: string; data?: Buffer; size?: number }[] = [{ data: Buffer.from([0, 255, 128, 13, 10]) }], complete = true) {
  async function* body() {
    for (const [name, values] of Object.entries(inputFields)) for (const value of Array.isArray(values) ? values : [values]) {
      yield Buffer.from(`--kod-test\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    }
    for (const file of files) {
      yield Buffer.from(`--kod-test\r\nContent-Disposition: form-data; name="${file.name ?? "attachments"}"; filename="${file.filename ?? "pièce.bin"}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      if (file.data) yield file.data;
      else { let remaining = file.size ?? 0; while (remaining) { const size = Math.min(remaining, 65_536); yield Buffer.alloc(size, 0xa5); remaining -= size; } }
      yield Buffer.from("\r\n");
    }
    if (complete) yield Buffer.from("--kod-test--\r\n");
  }
  return new Request("https://kod.bzh/api/v1/mail/send", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=kod-test" }, body: Readable.toWeb(Readable.from(body())) as ReadableStream<Uint8Array>, duplex: "half" } as RequestInit & { duplex: "half" });
}

describe("streaming mail uploads", () => {
  it("preserves binary bytes, Unicode filenames and repeated recipients, then removes temporary files", async () => {
    const parsed = await parseMailSendRequest(request({ ...fields, to: ["first@example.com", "second@example.com"], cc: '["copy@example.com"]' }));
    expect(parsed.input.to).toEqual(["first@example.com", "second@example.com"]);
    expect(parsed.input.cc).toEqual(["copy@example.com"]);
    const file = parsed.input.attachments![0] as UploadedAttachment;
    expect(file.filename).toBe("pièce.bin");
    expect(file.size).toBe(5);
    expect(Buffer.from(await new Response(Readable.toWeb(file.open()) as ReadableStream<Uint8Array>).arrayBuffer())).toEqual(Buffer.from([0, 255, 128, 13, 10]));
    await parsed.cleanup();
    expect(await readdir(directory)).toEqual([]);
  });
  it("accepts exactly 50 MB streamed without collecting the upload in memory", async () => {
    const parsed = await parseMailSendRequest(request(fields, [{ size: MAX_ATTACHMENT_BYTES }]));
    expect((parsed.input.attachments![0] as UploadedAttachment).size).toBe(MAX_ATTACHMENT_BYTES);
    await parsed.cleanup();
    expect(await readdir(directory)).toEqual([]);
  });
  it("rejects a cumulative overflow and cleans every file", async () => {
    await expect(parseMailSendRequest(request(fields, [{ size: MAX_ATTACHMENT_BYTES }, { size: 1 }]))).rejects.toMatchObject({ code: "payload_too_large", status: 413 });
    expect(await readdir(directory)).toEqual([]);
  });
  it("rejects a single oversized stream and cleans it", async () => {
    await expect(parseMailSendRequest(request(fields, [{ size: MAX_ATTACHMENT_BYTES + 1 }]))).rejects.toMatchObject({ status: 413 });
    expect(await readdir(directory)).toEqual([]);
  });
  it.each([
    ["duplicate subject", { ...fields, subject: ["one", "two"] }, [{}], true],
    ["unknown file field", fields, [{ name: "document" }], true],
    ["truncated body", fields, [{ data: Buffer.alloc(4000) }], false],
    ["unrecognized metadata", { ...fields, attachments: "local-file-path" }, [], true],
  ] as const)("rejects %s without leaving temporary files", async (_, input, files, complete) => {
    await expect(parseMailSendRequest(request(input, [...files], complete))).rejects.toMatchObject({ status: 400 });
    expect(await readdir(directory)).toEqual([]);
  });
  it("limits the number of files even for zero-byte uploads", async () => {
    await expect(parseMailSendRequest(request(fields, Array.from({ length: 101 }, () => ({ size: 0 }))))).rejects.toMatchObject({ status: 413 });
    expect(await readdir(directory)).toEqual([]);
  });
  it("cleans a request aborted while a file is being uploaded", async () => {
    const controller = new AbortController();
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({ pull(stream) {
      if (reads++ === 0) stream.enqueue(Buffer.from('--kod-test\r\nContent-Disposition: form-data; name="attachments"; filename="test.bin"\r\n\r\n'));
      else if (reads < 5) stream.enqueue(Buffer.alloc(1024));
      else controller.abort();
    } });
    const req = new Request("https://kod.bzh/api/v1/mail/send", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=kod-test" }, signal: controller.signal, body, duplex: "half" } as RequestInit & { duplex: "half" });
    await expect(parseMailSendRequest(req)).rejects.toMatchObject({ status: 400 });
    expect(await readdir(directory)).toEqual([]);
  });
});

it("accepts strict optional MDN flags in JSON/multipart and rejects ambiguous coercions", async () => {
  for (const value of [true, false]) {
    const json = await parseMailSendRequest(new Request("https://kod.bzh/api/v1/mail/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fields, requestReadReceipt: value }) }));
    expect(json.input.requestReadReceipt).toBe(value);
    const multipart = await parseMailSendRequest(request({ ...fields, requestReadReceipt: String(value) }));
    expect(multipart.input.requestReadReceipt).toBe(value); await multipart.cleanup();
  }
  for (const value of ["yes", "1", "TRUE", "false\r\nBcc: victim@example.net"]) await expect(parseMailSendRequest(request({ ...fields, requestReadReceipt: value }))).rejects.toMatchObject({ status: 400 });
  await expect(parseMailSendRequest(new Request("https://kod.bzh/api/v1/mail/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fields, requestReadReceipt: "false" }) }))).rejects.toMatchObject({ status: 400 });
});
