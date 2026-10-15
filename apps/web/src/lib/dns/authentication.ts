import { BlockList, isIP } from "node:net";

export type AuthResolver = {
  resolveTxt(name: string): Promise<string[][]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
};

export function txtTags(value: string): Map<string, string> {
  return new Map(value.split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const i = part.indexOf("=");
    return [part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim()];
  }));
}

function inNetwork(ip: string, network: string): boolean {
  const [address, prefix] = network.split("/");
  const version = isIP(address);
  if (!version || isIP(ip) !== version) return false;
  const bits = prefix === undefined ? (version === 4 ? 32 : 128) : Number(prefix);
  if (!Number.isInteger(bits) || bits < 0 || bits > (version === 4 ? 32 : 128)) throw Error("Préfixe SPF invalide");
  const block = new BlockList();
  block.addSubnet(address, bits, version === 4 ? "ipv4" : "ipv6");
  return block.check(ip, version === 4 ? "ipv4" : "ipv6");
}

/** Evaluate the sender IP, including DNS lookup budget, ordered qualifiers and redirects. */
export async function evaluateSpf(domain: string, ip: string, dns: AuthResolver): Promise<{ ok: boolean; detail: string }> {
  let lookups = 0;
  const path = new Set<string>();
  async function evaluate(name: string): Promise<"pass" | "fail" | "neutral"> {
    if (path.has(name)) throw Error("Boucle SPF");
    path.add(name);
    try {
      const entries = (await dns.resolveTxt(name)).map(parts => parts.join("")).filter(v => /^v=spf1(?:\s|$)/i.test(v));
      if (entries.length !== 1) throw Error("Un seul enregistrement SPF est requis");
      const terms = entries[0].trim().split(/\s+/).slice(1);
      if (terms.some(t => /^\+?all$/i.test(t))) throw Error("SPF autorise tous les expéditeurs (+all)");
      let redirect: string | undefined;
      for (const term of terms) {
        if (term.startsWith("redirect=")) { redirect = term.slice(9); continue; }
        if (term.includes("=")) continue;
        const qualifier = /^[+?~-]/.test(term) ? term[0] : "+";
        const mechanism = term.replace(/^[+?~-]/, "");
        let matches = false;
        if (mechanism === "all") matches = true;
        else if (mechanism.startsWith("ip4:") || mechanism.startsWith("ip6:")) {
          const network = mechanism.slice(4);
          if (!isIP(network.split("/")[0])) throw Error("Adresse SPF invalide");
          matches = inNetwork(ip, network);
        } else {
          if (++lookups > 10) throw Error("Limite de 10 recherches DNS SPF dépassée");
          if (mechanism.startsWith("include:")) matches = await evaluate(mechanism.slice(8).toLowerCase()) === "pass";
          else if (/^a(?::|\/|$)/.test(mechanism)) {
            const [host, prefix] = mechanism.slice(1).replace(/^:/, "").split("/");
            const addresses = isIP(ip) === 4 ? await dns.resolve4(host || name) : await dns.resolve6(host || name);
            matches = addresses.some(address => inNetwork(ip, address + (prefix ? "/" + prefix : "")));
          } else if (/^mx(?::|$)/.test(mechanism)) {
            const mx = await dns.resolveMx(mechanism.slice(2).replace(/^:/, "") || name);
            if (mx.length > 10) throw Error("Trop de MX dans le SPF");
            for (const record of mx) {
              const addresses = isIP(ip) === 4 ? await dns.resolve4(record.exchange) : await dns.resolve6(record.exchange);
              if (addresses.includes(ip)) matches = true;
            }
          } else throw Error("Mécanisme SPF non vérifiable : " + mechanism);
        }
        if (matches) return qualifier === "+" ? "pass" : qualifier === "?" ? "neutral" : "fail";
      }
      if (redirect) {
        if (++lookups > 10) throw Error("Limite de 10 recherches DNS SPF dépassée");
        return evaluate(redirect);
      }
      return "neutral";
    } finally { path.delete(name); }
  }
  try {
    const result = await evaluate(domain);
    return { ok: result === "pass", detail: result === "pass" ? "Le SPF autorise le serveur d’envoi." : "Le SPF n’autorise pas le serveur d’envoi." };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "SPF non vérifiable" };
  }
}

export function validDmarc(records: string[]): { ok: boolean; detail: string } {
  const policies = records.filter(value => /^v=DMARC1\s*;/i.test(value.trim()));
  if (policies.length !== 1) return { ok: false, detail: "Publier un seul enregistrement DMARC." };
  const names = policies[0].split(";").map(part => part.trim()).filter(Boolean).map(part => part.split("=")[0].trim().toLowerCase());
  if (new Set(names).size !== names.length || names[0] !== "v" || names[1] !== "p") return { ok: false, detail: "Balises DMARC dupliquées ou mal ordonnées." };
  const tags = txtTags(policies[0]);
  const policy = tags.get("p")?.toLowerCase();
  const ok = ["none", "quarantine", "reject"].includes(policy ?? "") &&
    ["adkim", "aspf"].every(key => !tags.has(key) || ["r", "s"].includes(tags.get(key)!)) &&
    (!tags.has("pct") || /^\d+$/.test(tags.get("pct")!) && Number(tags.get("pct")) <= 100);
  return { ok, detail: !ok ? "Politique DMARC invalide." : policy === "none" ? "DMARC en observation. Après contrôle des rapports, passer progressivement à quarantine puis reject." : "Politique DMARC active." };
}

export function dkimMatches(found: string, expected: string): boolean {
  const actual = txtTags(found), wanted = txtTags(expected);
  return (!actual.has("v") || actual.get("v") === "DKIM1") &&
    (actual.get("k") ?? "rsa") === wanted.get("k") &&
    actual.get("p")?.replace(/\s/g, "") === wanted.get("p")?.replace(/\s/g, "");
}
