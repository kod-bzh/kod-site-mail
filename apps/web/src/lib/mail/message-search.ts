import { z } from "zod";
import type { Prisma } from "@prisma/client";

const date = z.string().datetime({ offset: true });
const cursorSchema = z.object({ version: z.literal(1), id: z.string().min(1).max(100), createdAt: date, until: date }).strict();
export function messageSearch(url: URL) {
  const limit = z.coerce.number().int().min(1).max(100).parse(url.searchParams.get("limit") ?? 50);
  const from = url.searchParams.get("from")?.trim().toLowerCase();
  const recipient = url.searchParams.get("recipient")?.trim().toLowerCase();
  if (from) z.string().email().max(320).parse(from);
  if (recipient) z.string().email().max(320).parse(recipient);
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor ? cursorSchema.parse(JSON.parse(Buffer.from(z.string().max(2048).regex(/^[A-Za-z0-9_-]+$/).parse(rawCursor), "base64url").toString("utf8"))) : null;
  const since = url.searchParams.get("since");
  const requestedUntil = url.searchParams.get("until");
  if (since) date.parse(since);
  if (requestedUntil) date.parse(requestedUntil);
  const until = cursor?.until ?? requestedUntil ?? new Date().toISOString();
  if (requestedUntil && new Date(requestedUntil).getTime() !== new Date(until).getTime()) throw Error("cursor_period_changed");
  if (since && new Date(since) >= new Date(until)) throw Error("invalid_period");
  const filters: Prisma.OutboundMessageWhereInput[] = [
    { createdAt: { ...(since ? { gte: new Date(since) } : {}), lt: new Date(until) } },
    ...(from ? [{ fromAddress: from }] : []),
    ...(recipient ? [{ OR: ["to", "cc", "bcc"].map(field => ({ recipients: { path: [field], array_contains: [recipient] } })) }] : []),
    ...(cursor ? [{ OR: [{ createdAt: { lt: new Date(cursor.createdAt) } }, { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }] }] : []),
  ];
  return { limit, filters, period: { since: since ?? null, until },
    nextCursor: (last: { id: string; createdAt: Date }) => Buffer.from(JSON.stringify({ version: 1, id: last.id, createdAt: last.createdAt.toISOString(), until })).toString("base64url") };
}
