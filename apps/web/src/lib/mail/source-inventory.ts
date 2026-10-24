import { BlockList, isIP } from "node:net";
export type KnownSource = { cidr: string; kind: "microsoft365" | "known_other"; label: string };
export function classifySource(ip: string, sources: KnownSource[]) {
  if (ip === (process.env.MAIL_EGRESS_IP ?? "51.15.220.2")) return { kind: "kod", label: "KOD" };
  for (const source of sources) { const [network, prefix] = source.cidr.split("/"); const family = isIP(network);
    if (!family || !/^\d+$/.test(prefix ?? "") || Number(prefix) > (family === 4 ? 32 : 128)) continue;
    const list = new BlockList(); try { list.addSubnet(network, Number(prefix), family === 4 ? "ipv4" : "ipv6");
      if (list.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6")) return { kind: source.kind, label: source.label }; } catch { /* untrusted inventory cannot classify a source */ }
  }
  return { kind: "unknown", label: "Source à inventorier" };
}
