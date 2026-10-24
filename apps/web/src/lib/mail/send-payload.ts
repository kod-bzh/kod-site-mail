import { z } from "zod";
import { UploadedAttachment } from "./uploaded-attachment";

export const MAX_ATTACHMENT_BYTES = 50_000_000;
export const attachmentMetadataSchema = z.object({
  filename: z.string().trim().min(1).max(255).refine(v => !/[\r\n\0]/.test(v), "Nom de fichier invalide"),
  contentType: z.string().regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/).optional(),
});
export const attachmentSchema = attachmentMetadataSchema.extend({ content: z.string() });
export type MailAttachment = z.infer<typeof attachmentSchema>;
export type OutboundAttachment = MailAttachment | UploadedAttachment;
const recipients = z.union([z.string().min(3).max(320), z.array(z.string().min(3).max(320)).min(1).max(50)]);
export const sendBodySchema = z.object({
  requestReadReceipt: z.boolean().optional(),
  from: z.string().min(3).max(320), to: recipients,
  cc: recipients.optional(), bcc: recipients.optional(),
  subject: z.string().min(1).max(998),
  text: z.string().max(1_000_000).optional(), html: z.string().max(2_000_000).optional(),
  replyTo: z.string().max(320).optional(), attachments: z.array(attachmentSchema).optional(),
});

export function validateAttachments(attachments: OutboundAttachment[] = []): void {
  let total = 0;
  for (const [index, file] of attachments.entries()) {
    const fail = (reason: string): never => { throw new Error(`attachments[${index}] (${file.filename || "nom vide"}) : ${reason}`); };
    if (file instanceof UploadedAttachment) {
      if (!attachmentMetadataSchema.safeParse(file).success || !Number.isSafeInteger(file.size) || file.size < 0) fail("Fichier invalide");
      total += file.size;
      if (total > MAX_ATTACHMENT_BYTES) fail("total supérieur à 50 Mo (50 000 000 octets)");
      continue;
    }
    const parsed = attachmentSchema.safeParse(file);
    if (!parsed.success) fail(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
    if (file.content.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(file.content) || !/^[^=]*={0,2}$/.test(file.content)) fail("base64 illisible");
    total += file.content.length / 4 * 3 - (file.content.endsWith("==") ? 2 : file.content.endsWith("=") ? 1 : 0);
    if (total > MAX_ATTACHMENT_BYTES) fail("total supérieur à 50 Mo (50 000 000 octets décodés)");
    const tail = file.content.slice(-4);
    if (Buffer.from(tail, "base64").toString("base64") !== tail) fail("base64 non canonique ou illisible");
  }
}

export function decodeAttachments(attachments: MailAttachment[] = []) {
  validateAttachments(attachments);
  return attachments.map(file => ({ filename: file.filename.trim(), content: Buffer.from(file.content, "base64"), contentType: file.contentType ?? "application/octet-stream" }));
}

export function normalizeMailRecipients(input: { to: string | string[]; cc?: string | string[]; bcc?: string | string[] }) {
  const seen = new Set<string>();
  const read = (value: string | string[] | undefined) => (value === undefined ? [] : Array.isArray(value) ? value : [value]).map(raw => {
    const email = (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim().toLowerCase();
    if (/[\r\n\0]/.test(raw) || !z.string().email().safeParse(email).success) throw new Error(`Adresse invalide : ${raw}`);
    return email;
  }).filter(email => { if (seen.has(email)) return false; seen.add(email); return true; });
  return { to: read(input.to), cc: read(input.cc), bcc: read(input.bcc) };
}
