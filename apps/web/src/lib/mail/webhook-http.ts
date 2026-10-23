import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request } from "node:https";

const blocked = new BlockList();
for (const cidr of ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"]) {
  const [ip, bits] = cidr.split("/"); blocked.addSubnet(ip, Number(bits), "ipv4");
}
const ipv6Global = new BlockList(); ipv6Global.addSubnet("2000::", 3, "ipv6");
for (const [ip, bits] of [["2001:db8::", 32], ["2001::", 23], ["2002::", 16], ["3ffe::", 16], ["3fff::", 20]] as const) blocked.addSubnet(ip, bits, "ipv6");
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  return family === 4 ? !blocked.check(ip, "ipv4") : family === 6 && ipv6Global.check(ip, "ipv6") && !blocked.check(ip, "ipv6");
}
export function webhookUrl(raw: string): URL {
  const url = new URL(raw);
  if (raw.length > 2048 || url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash) throw Error("URL HTTPS publique requise, port 443, sans identifiants ni fragment");
  return url;
}
export async function resolveWebhook(raw: string) {
  const url = webhookUrl(raw), hostname = url.hostname.replace(/^\[|\]$/g, "");
  let deadline: NodeJS.Timeout | undefined;
  let addresses;
  try {
    addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(Error("DNS timeout")), 5000); deadline.unref(); }),
    ]);
  } finally { if (deadline) clearTimeout(deadline); }
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw Error("Destination webhook non publique");
  return { url, address: addresses[0] };
}
export async function postWebhook(raw: string, body: string, headers: Record<string, string>): Promise<number> {
  const { url, address } = await resolveWebhook(raw);
  // Resolve/validate for every retry, then pin the connection to that exact address.
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", family: address.family, agent: false,
      lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers },
      signal: AbortSignal.timeout(10_000),
    }, res => { const status = res.statusCode ?? 0; res.destroy(); resolve(status); });
    req.on("error", reject); req.end(body);
  });
}
