import busboy from "busboy";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { attachmentMetadataSchema, MAX_ATTACHMENT_BYTES, sendBodySchema, validateAttachments, type OutboundAttachment } from "./send-payload";
import { UploadedAttachment } from "./uploaded-attachment";
import type { z } from "zod";

export const MAX_MULTIPART_FILES = 100;
// Includes UTF-8 text/HTML and multipart headers, independently of Content-Length.
const MAX_MULTIPART_BYTES = MAX_ATTACHMENT_BYTES + 16_000_000;
type SendInput = Omit<z.infer<typeof sendBodySchema>, "attachments"> & { attachments?: OutboundAttachment[] };
export class MailRequestError extends Error {
  constructor(readonly code: string, readonly status: number, detail: string) { super(detail); }
}
const invalidBody = (detail: string) => new MailRequestError("invalid_body", 400, detail);
const tooLarge = (detail: string) => new MailRequestError("payload_too_large", 413, detail);
function validateBody(body: unknown) {
  const parsed = sendBodySchema.safeParse(body);
  if (!parsed.success) throw invalidBody(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

/** Parses only after authentication; never buffers multipart files in RAM. */
export async function parseMailSendRequest(req: Request): Promise<{ input: SendInput; cleanup: () => Promise<void> }> {
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(req.headers.get("content-type") ?? "")) {
    let body;
    try { body = await req.json(); } catch { throw invalidBody("JSON illisible"); }
    const input = validateBody(body);
    try { validateAttachments(input.attachments); } catch (error) {
      throw new MailRequestError("invalid_attachments", 400, (error as Error).message);
    }
    return { input, cleanup: async () => {} };
  }
  if (!req.body) throw invalidBody("Formulaire multipart vide");
  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({ headers: { "content-type": req.headers.get("content-type")! }, defParamCharset: "utf8",
      limits: { fileSize: MAX_ATTACHMENT_BYTES + 1, files: MAX_MULTIPART_FILES, fields: 160, parts: 260, fieldSize: 8_000_000, fieldNameSize: 100 },
    });
  } catch { throw invalidBody("Formulaire multipart invalide ou boundary absent"); }
  const directory = await mkdtemp(join(tmpdir(), "kod-mail-"));
  const cleanup = async () => { await rm(directory, { recursive: true, force: true }).catch(() => { console.error("[mail] Temporary upload cleanup failed"); }); };
  const controller = new AbortController();
  const signal = AbortSignal.any([req.signal, controller.signal, AbortSignal.timeout(120_000)]);
  const fields: Record<string, string | string[] | boolean> = Object.create(null);
  const uploads: UploadedAttachment[] = [];
  const writes: Promise<void>[] = [];
  let total = 0, received = 0, fileIndex = 0, failure: MailRequestError | undefined;
  const fail = (error: MailRequestError) => {
    failure ??= error;
    // Let busboy finish its current callback before destroying its streams.
    queueMicrotask(() => controller.abort(error));
  };
  parser.on("field", (name, value, info) => {
    if (failure) return;
    if (info.nameTruncated || info.valueTruncated) return fail(tooLarge(`Champ ${name} trop volumineux`));
    if (["to", "cc", "bcc"].includes(name)) {
      let values: unknown = [value];
      if (value.trim().startsWith("[")) {
        try { values = JSON.parse(value); } catch { return fail(invalidBody(`Tableau ${name} illisible`)); }
      }
      if (!Array.isArray(values) || values.some(v => typeof v !== "string")) return fail(invalidBody(`Champ ${name} invalide`));
      const previous = fields[name];
      fields[name] = [...(Array.isArray(previous) ? previous : previous ? [previous] : []), ...values];
      return;
    }
    if (name === "requestReadReceipt") {
      if (name in fields || !["true", "false"].includes(value)) return fail(invalidBody("requestReadReceipt doit être true ou false"));
      fields[name] = value === "true"; return;
    }
    if (!["from", "subject", "text", "html", "replyTo"].includes(name)) return fail(invalidBody(`Champ multipart inconnu : ${name}`));
    if (name in fields) return fail(invalidBody(`Champ ${name} répété`));
    fields[name] = value;
  });
  parser.on("file", (name, file, info) => {
    // Discarded parts are not owned by a pipeline, but busboy can still abort them.
    file.on("error", () => {});
    const index = fileIndex++;
    const metadata = attachmentMetadataSchema.safeParse({ filename: info.filename, contentType: info.mimeType });
    if (failure || !["attachments", "attachments[]"].includes(name) || !metadata.success || !["binary", "7bit", "8bit"].includes(info.encoding.toLowerCase())) {
      file.resume();
      return fail(new MailRequestError("invalid_attachments", 400, `attachments[${index}] : fichier, nom, type ou encodage invalide`));
    }
    const path = join(directory, String(index)); // Never use the supplied filename on disk.
    let size = 0;
    const counter = new Transform({ transform(chunk: Buffer, _, done) {
      size += chunk.length; total += chunk.length;
      if (total > MAX_ATTACHMENT_BYTES) {
        const error = tooLarge(`attachments[${index}] (${metadata.data.filename}) : total supérieur à 50 Mo (50 000 000 octets)`);
        fail(error); done(error);
      } else done(null, chunk);
    } });
    file.on("limit", () => fail(tooLarge(`attachments[${index}] : limite de 50 Mo dépassée`)));
    writes.push(pipeline(file, counter, createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal }).then(() => {
      uploads[index] = new UploadedAttachment(metadata.data.filename, metadata.data.contentType ?? "application/octet-stream", size, path);
    }).catch(() => {
      if (!failure && !signal.aborted) {
        fail(new MailRequestError("upload_unavailable", 503, "Réception du fichier indisponible ; aucun envoi effectué"));
      }
    }));
  });
  parser.on("filesLimit", () => fail(tooLarge(`Maximum ${MAX_MULTIPART_FILES} pièces jointes en multipart`)));
  parser.on("fieldsLimit", () => fail(tooLarge("Trop de champs multipart")));
  parser.on("partsLimit", () => fail(tooLarge("Trop de parties multipart")));
  const requestLimit = new Transform({ transform(chunk: Buffer, _, done) {
    received += chunk.length;
    if (received > MAX_MULTIPART_BYTES) {
      const error = tooLarge("Requête multipart trop volumineuse"); fail(error); done(error);
    }
    else done(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(req.body as NodeReadableStream), requestLimit, parser, { signal });
    await Promise.all(writes);
    if (failure) throw failure;
    const input = { ...validateBody(fields), attachments: uploads };
    validateAttachments(input.attachments);
    return { input, cleanup };
  } catch (error) {
    controller.abort();
    await Promise.allSettled(writes);
    await cleanup();
    if (failure) throw failure;
    if (error instanceof MailRequestError) throw error;
    throw invalidBody("Formulaire multipart incomplet, interrompu ou illisible");
  }
}
