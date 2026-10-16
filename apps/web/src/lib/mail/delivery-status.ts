export type RecipientDelivery = { delivered?: string; smtpReply?: string; displayed?: string };
export type RecipientState = "QUEUED" | "ACCEPTED" | "DELIVERED" | "FAILED" | "UNKNOWN";
export function recipientState(status: RecipientDelivery): RecipientState {
  if (status.delivered === "no") return "FAILED";
  if (status.delivered === "yes") return "DELIVERED";
  if (status.delivered === "queued") return "QUEUED";
  // Stalwart can retain its synthetic submission reply after the transport
  // queue entry disappears. No reply with delivered=unknown proves delivery.
  return "UNKNOWN";
}
export function permanentAddressFailure(status: RecipientDelivery): boolean {
  // Policy/authentication/content failures must never poison a recipient address.
  return status.delivered === "no" && /^5\d\d\s+5\.1\.(?:1|2|3|6)\b/.test(status.smtpReply ?? "");
}
export function aggregateDelivery(statuses: Record<string, RecipientDelivery>, expected: string[]): string {
  const states = expected.map(address => recipientState(statuses[address] ?? {}));
  if (!states.length || states.every(state => state === "UNKNOWN")) return "UNKNOWN";
  if (states.every(state => state === "DELIVERED")) return "DELIVERED";
  if (states.every(state => state === "FAILED")) return "FAILED";
  if (states.some(state => state === "QUEUED")) return "QUEUED";
  if (states.some(state => state === "UNKNOWN")) return "UNKNOWN";
  if (states.some(state => state === "FAILED")) return "PARTIAL";
  return "ACCEPTED";
}
export const DELIVERY_NOTICE = "Accepté par le serveur destinataire ne signifie ni boîte principale, ni lecture. Le classement spam n’est pas connu de cette API.";
