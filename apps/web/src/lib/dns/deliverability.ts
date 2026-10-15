import { Resolver } from "node:dns/promises";
import { domainDnsRecords } from "./domain-records";
import { evaluateSpf, validDmarc, dkimMatches } from "./authentication";
import { getPlatformMailHost, type DnsCheckRow, type DnsVerifyResult } from "./dns-records";

export const DELIVERABILITY_NOTICE = "L’envoi est autorisé sans attendre le DNS. Les réglages ci-dessous améliorent la délivrabilité, sans garantir l’arrivée en boîte principale. Conserver les MX actuels si la réception reste chez un autre fournisseur. Fusionner le SPF existant : ne jamais créer deux SPF ni supprimer un autre expéditeur. Ne pas remplacer une politique DMARC existante plus stricte.";

export async function checkDomainDeliverability(fqdn: string, platformHost = getPlatformMailHost()): Promise<DnsVerifyResult> {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  const configuration = await domainDnsRecords(fqdn, platformHost);
  const mailHost = `mail.${platformHost}`;
  const warnings = [DELIVERABILITY_NOTICE];
  let addresses: string[] = [];
  addresses = (await Promise.allSettled([resolver.resolve4(mailHost), resolver.resolve6(mailHost)])).flatMap(result => result.status === "fulfilled" ? result.value : []);
  const results = await Promise.all(configuration.records.map(async record => {
    const dkim = record.name.includes("._domainkey.");
    const dmarc = record.name === `_dmarc.${fqdn}`;
    const spf = record.type === "TXT" && record.name === fqdn;
    const row: DnsCheckRow = { record, ok: false, found: "—", issue: null, required: dkim || dmarc || spf };
    try {
      if (record.type === "TXT") {
        const entries = (await resolver.resolveTxt(record.name)).map(chunks => chunks.join(""));
        row.found = entries.join(" | ");
        if (dkim) {
          const keys = entries.filter(value => /(?:^|;)\s*p\s*=/i.test(value));
          row.ok = keys.length === 1 && dkimMatches(keys[0], record.value);
          row.detail = row.ok ? "Clé publique DKIM conforme à la clé active du serveur." : "Publier la clé DKIM exacte fournie ci-dessus.";
        } else if (dmarc) Object.assign(row, validDmarc(entries));
        else if (spf) {
          const evaluations = await Promise.all(addresses.map(ip => evaluateSpf(fqdn, ip, resolver)));
          row.ok = evaluations.length > 0 && evaluations.every(result => result.ok);
          row.detail = evaluations.map(result => result.detail).join(" ") || "Adresse du serveur d’envoi introuvable.";
        }
      } else if (record.type === "MX") {
        const entries = await resolver.resolveMx(fqdn);
        row.mxRecords = entries.map(item => ({ priority: item.priority, host: item.exchange, matchesExpected: item.exchange.replace(/\.$/, "").toLowerCase() === mailHost }));
        row.ok = row.mxRecords.some(item => item.matchesExpected);
        row.found = entries.map(item => `${item.priority} ${item.exchange}`).join(", ");
        row.detail = "Réception seulement : conserver les MX existants pour continuer à recevoir chez Google, Microsoft ou un autre fournisseur.";
      } else if (record.type === "CNAME") {
        const entries = await resolver.resolveCname(record.name);
        row.ok = entries.some(value => value.replace(/\.$/, "").toLowerCase() === mailHost);
        row.found = entries.join(", ");
        row.detail = "Optionnel pour l’envoi : configuration automatique des logiciels de messagerie.";
      } else if (record.type === "SRV") {
        const entries = await resolver.resolveSrv(record.name);
        row.ok = entries.some(item => item.name.replace(/\.$/, "").toLowerCase() === mailHost && item.port === (record.name.startsWith("_imaps") ? 993 : 587));
        row.found = entries.map(item => `${item.priority} ${item.weight} ${item.port} ${item.name}`).join(", ");
        row.detail = "Optionnel pour l’envoi par API : découverte des services de messagerie.";
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      row.issue = code === "ENOTFOUND" ? "NXDOMAIN" : code === "ENODATA" ? "ENODATA" : null;
      row.detail = code === "ETIMEOUT" || code === "ESERVFAIL" ? "DNS momentanément inaccessible : relancer la vérification." : "Enregistrement absent ou non vérifiable.";
    }
    return row;
  }));
  if (!configuration.signingConfigured) results.push({
    record: { type: "DKIM", name: fqdn, value: "Clé RSA active pour ce domaine" },
    ok: false, found: "Non disponible", issue: null, required: true,
    detail: "La clé de signature n’est pas encore disponible. Relancer la vérification ; contacter l’administrateur si cela persiste.",
  });
  results.push({
    record: { type: "DKIM", name: `signature.${fqdn}`, value: "Signature activée pour les envois authentifiés" },
    ok: configuration.signingEnabled === true,
    found: configuration.signingEnabled === true ? "Activée" : configuration.signingEnabled === false ? "Désactivée" : "Non vérifiable automatiquement",
    required: true, issue: null,
    detail: "Réglage géré par la plateforme. Confirmer aussi la signature dans les en-têtes du message reçu.",
  });
  const reverse: DnsCheckRow = {
    record: { type: "PTR", name: mailHost, value: mailHost },
    ok: false, found: "—", required: true, issue: null,
    detail: "Réglage géré par la plateforme : le reverse DNS du serveur doit correspondre à son nom d’envoi.",
  };
  try {
    const ptrs = await Promise.all(addresses.map(ip => resolver.reverse(ip)));
    reverse.found = ptrs.flat().join(", ");
    reverse.ok = addresses.length > 0 && ptrs.every(names => names.some(name => name.replace(/\.$/, "").toLowerCase() === mailHost));
  } catch { /* leave non-passing */ }
  results.push(reverse);
  let domainExists = true;
  try { await resolver.resolveTxt(fqdn); } catch (error) { domainExists = (error as NodeJS.ErrnoException).code !== "ENOTFOUND"; }
  if (results.some(row => row.record.name === `_dmarc.${fqdn}` && row.ok && /observation/.test(row.detail ?? ""))) {
    warnings.push("DMARC p=none : ajouter une adresse de rapports rua surveillée, vérifier tous les expéditeurs, puis renforcer la politique progressivement.");
  }
  warnings.push("La signature et l’alignement SPF/DKIM/DMARC doivent aussi être confirmés dans les en-têtes d’un message reçu à l’extérieur. La réputation, les plaintes, les rebonds et le contenu ne sont pas certifiés par un contrôle DNS. Pour les campagnes : consentement et désabonnement en un clic.");
  return { verified: results.filter(row => row.required).every(row => row.ok), domainExists, results, warnings, checkedAt: new Date().toISOString(), sendingAllowed: true };
}
