import { Resolver } from "node:dns/promises";
import { getDomain } from "tldts";
export function ruaAddresses(policy: string): string[] {
  const value = policy.split(";").find(tag => /^\s*rua\s*=/i.test(tag))?.split("=").slice(1).join("=") ?? "";
  return [...new Set(value.split(",").map(item => item.trim().replace(/![0-9]+[kmgt]?$/i, "")).flatMap(item => {
    if (!/^mailto:/i.test(item)) return []; let address: string; try { address = decodeURIComponent(item.slice(7)); } catch { return []; }
    return /^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]{1,253}$/.test(address) ? [address.toLowerCase()] : [];
  }))].slice(0, 10);
}
export async function checkRuaAuthorization(domain: string, policy: string) {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  return Promise.all(ruaAddresses(policy).map(async address => {
    const target = address.split("@")[1], sameOrganization = getDomain(domain) && getDomain(domain) === getDomain(target);
    const base = { address, source: "published_dmarc_rua_and_dns", scope: "domain", observedAt: new Date().toISOString(), targetDomain: target };
    if (sameOrganization) return { ...base, externalAuthorizationRequired: false, authorized: null, availability: "available", reason: "same_organizational_domain_no_external_authorization_required", action: "Vérifier la réception et la surveillance de cette adresse." };
    const name = `${domain}._report._dmarc.${target}`;
    try { const records = (await resolver.resolveTxt(name)).map(chunks => chunks.join("")); const authorized = records.some(value => /^v=DMARC1(?:;|$)/i.test(value));
      return { ...base, externalAuthorizationRequired: true, authorizationName: name, authorized, availability: "available", reason: authorized ? null : "external_rua_not_authorized", action: authorized ? "Vérifier la réception des rapports." : `Le domaine destinataire doit autoriser la réception par un TXT v=DMARC1 à ${name}.` };
    } catch (error) { const absent = ["ENOTFOUND", "ENODATA"].includes((error as NodeJS.ErrnoException).code ?? "");
      return { ...base, externalAuthorizationRequired: true, authorizationName: name, authorized: absent ? false : null, availability: absent ? "available" : "unknown",
        reason: absent ? "external_rua_authorization_missing" : "authorization_dns_unavailable", action: "Vérifier l’autorisation DNS du destinataire sans changer la politique ou les MX." };
    }
  }));
}
