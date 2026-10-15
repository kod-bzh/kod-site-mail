import { readFileSync } from "node:fs";
import { join } from "node:path";

const STALWART_URL = process.env.STALWART_URL ?? "";
const STALWART_API_KEY = process.env.STALWART_API_KEY ?? "";

type JmapRequest = {
  using: string[];
  methodCalls: [string, Record<string, unknown>, string][];
};

export type StalwartFailure = { unavailable: true } | { error: string };
export type StalwartStatus = "ok" | "unconfigured" | "unreachable";

export type StalwartSetIssue = {
  type: string;
  description?: string;
  properties?: string[];
  objectId?: { object: string; id: string };
};

function stalwartJmapUrl() {
  const base = getStalwartJmapUrl();
  return `${base}/jmap`;
}

function firstMethodResponse(res: unknown): unknown[] | null {
  if (!res || typeof res !== "object" || !("methodResponses" in res)) return null;
  const responses = (res as { methodResponses: unknown[][] }).methodResponses;
  return responses?.[0] ?? null;
}

export function isStalwartFailure(res: unknown): res is StalwartFailure {
  if (typeof res === "object" && res !== null && ("unavailable" in res || "error" in res)) {
    return true;
  }

  const first = firstMethodResponse(res);
  if (!first) return false;
  if (first[0] === "error") return true;

  const body = first[1];
  if (!body || typeof body !== "object") return false;

  const patch = body as {
    notCreated?: Record<string, unknown>;
    notUpdated?: Record<string, unknown>;
    notDestroyed?: unknown[];
  };

  if (patch.notCreated && Object.keys(patch.notCreated).length > 0) return true;
  if (patch.notUpdated && Object.keys(patch.notUpdated).length > 0) return true;
  if (patch.notDestroyed && patch.notDestroyed.length > 0) return true;

  return false;
}

/** Premier échec x:*\/set (notCreated, notUpdated, error JMAP ou indisponibilité). */
export function extractStalwartSetIssue(res: unknown): StalwartSetIssue | null {
  if (typeof res === "object" && res !== null && "unavailable" in res) {
    return { type: "unavailable" };
  }
  if (typeof res === "object" && res !== null && "error" in res) {
    return { type: String((res as { error: string }).error) };
  }

  const first = firstMethodResponse(res);
  if (!first) return null;
  if (first[0] === "error") {
    const err = first[1] as { type?: string };
    return { type: err.type ?? "jmapError" };
  }

  const body = first[1] as {
    notCreated?: Record<string, StalwartSetIssue>;
    notUpdated?: Record<string, StalwartSetIssue>;
  };
  const bucket = body.notCreated ?? body.notUpdated;
  if (!bucket) return null;
  return Object.values(bucket)[0] ?? null;
}

/** Compte Stalwart orphelin lors d'un primaryKeyViolation (Account uniquement, pas MailingList). */
export function extractStalwartOrphanAccountId(
  issue: StalwartSetIssue | null
): string | undefined {
  if (issue?.type !== "primaryKeyViolation") return undefined;
  if (issue.objectId?.object !== "Account") return undefined;
  return issue.objectId.id;
}

export function isStalwartAliasConflict(issue: StalwartSetIssue | null): boolean {
  return issue?.type === "primaryKeyViolation" && issue.objectId?.object === "MailingList";
}

/** Mot de passe refusé par Stalwart (règles de robustesse, pas seulement la longueur). */
export function isStalwartPasswordIssue(issue: StalwartSetIssue | null): boolean {
  return (
    issue?.type === "invalidProperties" &&
    (issue.properties?.includes("secret") ?? false)
  );
}

export function isStalwartDomainIssue(issue: StalwartSetIssue | null): boolean {
  return issue?.type === "invalidForeignKey" && issue.objectId?.object === "Domain";
}

export function isStalwartTransportIssue(issue: StalwartSetIssue | null): boolean {
  if (!issue) return false;
  return (
    issue.type === "unavailable" ||
    issue.type.startsWith("Stalwart ") ||
    issue.type === "jmapError"
  );
}

export async function getStalwartStatus(): Promise<StalwartStatus> {
  if (!STALWART_API_KEY || !getStalwartJmapUrl()) {
    return "unconfigured";
  }

  const result = await jmapCall([["x:Domain/query", { filter: {} }, "ping"]], 3_000);
  return isStalwartFailure(result) ? "unreachable" : "ok";
}

const JMAP_CORE_USING = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"] as const;
const JMAP_MAIL_USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:submission",
  "urn:stalwart:jmap",
] as const;

async function jmapCall(
  methodCalls: JmapRequest["methodCalls"],
  timeoutMs = 15_000,
  using: readonly string[] = JMAP_CORE_USING
) {
  if (!STALWART_API_KEY) {
    return { unavailable: true as const };
  }

  const body: JmapRequest = {
    using: [...using],
    methodCalls,
  };

  try {
    const res = await fetch(stalwartJmapUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${STALWART_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return { error: `Stalwart JMAP error: ${res.status}` as const };
    }

    return res.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { error: `Stalwart unreachable: ${detail}` as const };
  }
}

export async function deleteDomain(stalwartDomainId: string) {
  return jmapCall([
    [
      "x:Domain/set",
      {
        destroy: [stalwartDomainId],
      },
      "d1",
    ],
  ]);
}

export async function createDomain(fqdn: string) {
  const id = `domain-${Date.now()}`;
  return jmapCall([
    [
      "x:Domain/set",
      {
        create: {
          [id]: {
            name: fqdn,
            dkimManagement: { "@type": "Automatic" },
            dnsManagement: { "@type": "Manual" },
          },
        },
      },
      "c1",
    ],
  ]);
}

export type StalwartSubAddressingRule = {
  match: { if: string; then: string }[];
  else: string;
};

export async function getDomain(stalwartDomainId: string) {
  return jmapCall([["x:Domain/get", { ids: [stalwartDomainId] }, "g1"]]);
}

function extractDomainRecord(
  res: unknown,
  stalwartDomainId: string
): Record<string, unknown> | null {
  if (!res || typeof res !== "object" || !("methodResponses" in res)) return null;
  const body = (res as { methodResponses: unknown[][] }).methodResponses?.[0]?.[1];
  if (!body || typeof body !== "object" || !("list" in body)) return null;
  const list = (body as { list: unknown }).list;
  if (!Array.isArray(list)) return null;
  const row = list.find(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && (item as { id?: string }).id === stalwartDomainId
  );
  return row ?? null;
}

export function extractDomainSubAddressingRule(res: unknown, stalwartDomainId: string): StalwartSubAddressingRule | null {
  const row = extractDomainRecord(res, stalwartDomainId);
  if (!row) return null;
  const sub = row.subAddressing;
  if (!sub || typeof sub !== "object") return null;
  const typed = sub as { "@type"?: string; customRule?: StalwartSubAddressingRule };
  if (typed["@type"] !== "Custom" || !typed.customRule) return null;
  return typed.customRule;
}

export function extractDomainCatchAllAddress(res: unknown, stalwartDomainId: string): string | null {
  const row = extractDomainRecord(res, stalwartDomainId);
  if (!row) return null;
  const value = row.catchAllAddress;
  return typeof value === "string" ? value : null;
}

export async function updateDomainCatchAll(stalwartDomainId: string, catchAllAddress: string | null) {
  return jmapCall([
    [
      "x:Domain/set",
      {
        update: {
          [stalwartDomainId]: {
            catchAllAddress,
          },
        },
      },
      "u1",
    ],
  ]);
}

export async function updateDomainSubAddressingCustom(
  stalwartDomainId: string,
  customRule: StalwartSubAddressingRule
) {
  return jmapCall([
    [
      "x:Domain/set",
      {
        update: {
          [stalwartDomainId]: {
            subAddressing: {
              "@type": "Custom",
              customRule,
            },
          },
        },
      },
      "u1",
    ],
  ]);
}

export async function resetDomainSubAddressingEnabled(stalwartDomainId: string) {
  return jmapCall([
    [
      "x:Domain/set",
      {
        update: {
          [stalwartDomainId]: {
            subAddressing: { "@type": "Enabled" },
          },
        },
      },
      "u1",
    ],
  ]);
}

const STALWART_DEFAULT_LOCALE = "fr_FR";
const STALWART_DEFAULT_TIMEZONE = "Europe/Paris";
const STALWART_ENCRYPTION_PUBLIC_KEY_ID = process.env.STALWART_ENCRYPTION_PUBLIC_KEY_ID ?? "";

function normalizePgpKey(raw: string): string {
  return raw.replace(/\\n/g, "\n").trim();
}

function decodePlatformPgpFromEnv(): string {
  const b64 = process.env.STALWART_PLATFORM_PGP_PUBLIC_KEY_B64?.trim();
  if (b64) {
    return Buffer.from(b64, "base64").toString("utf8").trim();
  }
  const inline = process.env.STALWART_PLATFORM_PGP_PUBLIC_KEY?.trim();
  if (inline) return normalizePgpKey(inline);
  return "";
}

export function resolvePlatformPgpPublicKey(): string {
  const fromEnv = decodePlatformPgpFromEnv();
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === "development") {
    try {
      return readFileSync(join(process.cwd(), "config/stalwart-dev-public.pem"), "utf8").trim();
    } catch {
      return "";
    }
  }
  return "";
}

/** Chiffrement au repos configuré (prod : clé plateforme ou ID Stalwart). */
export function isEncryptionAtRestConfigured(): boolean {
  if (STALWART_ENCRYPTION_PUBLIC_KEY_ID) return true;
  return Boolean(resolvePlatformPgpPublicKey());
}

function assertHttpsServiceUrl(url: string, label: string) {
  if (!url || process.env.NODE_ENV !== "production") return;
  if (!url.startsWith("https://")) {
    throw new Error(`${label} must use HTTPS in production`);
  }
}

function defaultEncryptionAtRest():
  | { "@type": "Disabled" }
  | {
      "@type": "Aes256";
      publicKey: string;
      encryptOnAppend: false;
      allowSpamTraining: false;
    } {
  if (STALWART_ENCRYPTION_PUBLIC_KEY_ID) {
    return {
      "@type": "Aes256",
      publicKey: STALWART_ENCRYPTION_PUBLIC_KEY_ID,
      encryptOnAppend: false,
      allowSpamTraining: false,
    };
  }
  return { "@type": "Disabled" };
}

function accountUserDefaults(displayName?: string | null) {
  const description = displayName?.trim() || undefined;
  return {
    locale: STALWART_DEFAULT_LOCALE,
    timeZone: STALWART_DEFAULT_TIMEZONE,
    encryptionAtRest: defaultEncryptionAtRest(),
    ...(description ? { description } : {}),
  };
}

function accountPasswordPatch(password: string) {
  return {
    credentials: {
      "0": {
        "@type": "Password",
        secret: password,
      },
    },
  };
}

async function enableAccountEncryptionAtRest(accountId: string, publicKeyPem: string) {
  const pkClientId = `pk-${Date.now()}`;
  const pkRes = await jmapCall([
    [
      "x:PublicKey/set",
      {
        accountId,
        create: {
          [pkClientId]: {
            description: "framm-platform",
            emailAddresses: {},
            key: publicKeyPem,
          },
        },
      },
      "pk1",
    ],
  ]);
  if (isStalwartFailure(pkRes)) return pkRes;

  const publicKeyId = extractStalwartCreatedId(pkRes);
  if (!publicKeyId) {
    return { error: "Stalwart PublicKey created without id" as const };
  }

  return jmapCall([
    [
      "x:Account/set",
      {
        update: {
          [accountId]: {
            encryptionAtRest: {
              "@type": "Aes256",
              publicKey: publicKeyId,
              encryptOnAppend: false,
              allowSpamTraining: false,
            },
          },
        },
      },
      "u1",
    ],
  ]);
}

export async function createAccount(
  localPart: string,
  domainId: string,
  password: string,
  displayName?: string | null
) {
  if (process.env.NODE_ENV === "production" && !isEncryptionAtRestConfigured()) {
    return { error: "encryption_not_configured" as const };
  }

  const id = `account-${Date.now()}`;
  const res = await jmapCall([
    [
      "x:Account/set",
      {
        create: {
          [id]: {
            "@type": "User",
            name: localPart,
            domainId,
            ...accountPasswordPatch(password),
            ...accountUserDefaults(displayName),
            roles: { "@type": "User" },
            permissions: { "@type": "Inherit" },
            aliases: {},
            quotas: {},
          },
        },
      },
      "c1",
    ],
  ]);

  const platformKey = resolvePlatformPgpPublicKey();
  if (isStalwartFailure(res) || !platformKey || STALWART_ENCRYPTION_PUBLIC_KEY_ID) {
    return res;
  }

  const accountId = extractStalwartCreatedId(res);
  if (!accountId) return res;

  const encRes = await enableAccountEncryptionAtRest(accountId, platformKey);
  if (isStalwartFailure(encRes)) return encRes;

  return res;
}

export async function updateAccount(
  stalwartAccountId: string,
  patch: {
    description?: string | null;
    password?: string;
    quotaBytes?: number | null;
  }
) {
  const update: Record<string, unknown> = {};
  if (patch.description !== undefined) update.description = patch.description;
  if (patch.password !== undefined) Object.assign(update, accountPasswordPatch(patch.password));
  if (patch.quotaBytes !== undefined) {
    update["quotas/maxDiskQuota"] = patch.quotaBytes;
  }

  return jmapCall([
    [
      "x:Account/set",
      {
        update: {
          [stalwartAccountId]: update,
        },
      },
      "u1",
    ],
  ]);
}

export async function updateAccountPassword(stalwartAccountId: string, password: string) {
  return updateAccount(stalwartAccountId, { password });
}

export async function deleteAccount(stalwartAccountId: string) {
  return jmapCall([
    [
      "x:Account/set",
      {
        destroy: [stalwartAccountId],
      },
      "d1",
    ],
  ]);
}

export function extractStalwartCreatedId(res: unknown): string | null {
  if (!res || typeof res !== "object" || !("methodResponses" in res)) return null;
  const created = (res as { methodResponses: unknown[][] }).methodResponses?.[0]?.[1] as
    | { created?: Record<string, { id?: string }> }
    | undefined;
  const first = created?.created && Object.values(created.created)[0];
  return first?.id ?? null;
}

export function extractJmapQueryIds(res: unknown): string[] {
  if (!res || typeof res !== "object" || !("methodResponses" in res)) return [];
  const body = (res as { methodResponses: unknown[][] }).methodResponses?.[0]?.[1];
  if (!body || typeof body !== "object" || !("ids" in body)) return [];
  const ids = (body as { ids: unknown }).ids;
  return Array.isArray(ids) ? (ids as string[]) : [];
}

function recipientsMapMulti(destinations: string[]): Record<string, boolean> {
  return Object.fromEntries(destinations.map((email) => [email, true]));
}

function parseEmailLocalPart(email: string): string {
  return email.split("@")[0] ?? email;
}

function extractMailingListRecords(res: unknown): { id: string; emailAddress?: string }[] {
  if (!res || typeof res !== "object" || !("methodResponses" in res)) return [];
  const body = (res as { methodResponses: unknown[][] }).methodResponses?.[0]?.[1];
  if (!body || typeof body !== "object" || !("list" in body)) return [];
  const list = (body as { list: unknown }).list;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (item): item is { id: string; emailAddress?: string } =>
      typeof item === "object" && item !== null && "id" in item
  );
}

export async function resolveStalwartDomainId(
  fqdn: string,
  cachedId?: string | null
): Promise<{ id: string | null; unavailable: boolean }> {
  if (cachedId) return { id: cachedId, unavailable: false };

  const queryRes = await jmapCall([["x:Domain/query", { filter: { text: fqdn } }, "q1"]]);
  if (isStalwartFailure(queryRes)) return { id: null, unavailable: true };

  const ids = extractJmapQueryIds(queryRes);
  return { id: ids[0] ?? null, unavailable: false };
}

/** Redirection email → Stalwart MailingList (un ou plusieurs destinataires). */
export async function createAlias(
  source: string,
  destination: string,
  stalwartDomainId: string
) {
  return createMailingListWithRecipients(source, [destination], stalwartDomainId);
}

export async function createMailingListWithRecipients(
  source: string,
  destinations: string[],
  stalwartDomainId: string
) {
  const id = `ml-${Date.now()}`;
  return jmapCall([
    [
      "x:MailingList/set",
      {
        create: {
          [id]: {
            name: parseEmailLocalPart(source),
            domainId: stalwartDomainId,
            recipients: recipientsMapMulti(destinations),
          },
        },
      },
      "c1",
    ],
  ]);
}

export async function patchMailingListRecipients(
  stalwartListId: string,
  toAdd: string[],
  toRemove: string[]
) {
  const patch: Record<string, unknown> = {};
  for (const email of toAdd) patch[`recipients/${email}`] = true;
  for (const email of toRemove) patch[`recipients/${email}`] = null;

  if (Object.keys(patch).length === 0) return { methodResponses: [] };

  return jmapCall([
    [
      "x:MailingList/set",
      {
        update: {
          [stalwartListId]: patch,
        },
      },
      "u1",
    ],
  ]);
}

export async function queryMailingListByEmail(email: string) {
  const localPart = parseEmailLocalPart(email);
  return jmapCall([["x:MailingList/query", { filter: { text: localPart } }, "q1"]]);
}

export async function updateAlias(
  stalwartListId: string,
  destination: string,
  previousDestination?: string
) {
  const patch: Record<string, unknown> = {
    [`recipients/${destination}`]: true,
  };
  if (previousDestination && previousDestination !== destination) {
    patch[`recipients/${previousDestination}`] = null;
  }

  return jmapCall([
    [
      "x:MailingList/set",
      {
        update: {
          [stalwartListId]: patch,
        },
      },
      "u1",
    ],
  ]);
}

export async function deleteAlias(stalwartListId: string) {
  return jmapCall([
    [
      "x:MailingList/set",
      {
        destroy: [stalwartListId],
      },
      "d1",
    ],
  ]);
}

export async function resolveEmailAliasStalwartId(
  stalwartAliasId: string | null,
  source: string
): Promise<{ id: string | null; unavailable: boolean }> {
  if (stalwartAliasId) return { id: stalwartAliasId, unavailable: false };

  const queryRes = await queryMailingListByEmail(source);
  if (isStalwartFailure(queryRes)) return { id: null, unavailable: true };

  const ids = extractJmapQueryIds(queryRes);
  if (ids.length === 0) return { id: null, unavailable: false };
  if (ids.length === 1) return { id: ids[0], unavailable: false };

  const getRes = await jmapCall([["x:MailingList/get", { ids }, "g1"]]);
  if (isStalwartFailure(getRes)) return { id: null, unavailable: true };

  const match = extractMailingListRecords(getRes).find(
    (list) => list.emailAddress === source
  );
  return { id: match?.id ?? null, unavailable: false };
}

export async function listAccounts() {
  return jmapCall([["x:Account/query", { filter: {} }, "q1"]]);
}

export async function queryAccountByEmail(email: string) {
  const localPart = parseEmailLocalPart(email);
  return jmapCall([["x:Account/query", { filter: { text: localPart } }, "q1"]]);
}

function extractAccountRecords(res: unknown): { id: string; emailAddress?: string }[] {
  if (!res || typeof res !== "object" || !("methodResponses" in res)) return [];
  const body = (res as { methodResponses: unknown[][] }).methodResponses?.[0]?.[1];
  if (!body || typeof body !== "object" || !("list" in body)) return [];
  const list = (body as { list: unknown }).list;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (item): item is { id: string; emailAddress?: string } =>
      typeof item === "object" && item !== null && "id" in item
  );
}

export type StalwartEmailAlias = {
  name: string;
  domainId: string;
  enabled?: boolean;
};

export async function getAccount(stalwartAccountId: string) {
  return jmapCall([["x:Account/get", { ids: [stalwartAccountId] }, "g1"]]);
}

function extractAccountRecordById(
  res: unknown,
  stalwartAccountId: string
): Record<string, unknown> | null {
  if (!res || typeof res !== "object" || !("methodResponses" in res)) return null;
  const body = (res as { methodResponses: unknown[][] }).methodResponses?.[0]?.[1];
  if (!body || typeof body !== "object" || !("list" in body)) return null;
  const list = (body as { list: unknown }).list;
  if (!Array.isArray(list)) return null;
  const row = list.find(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && (item as { id?: string }).id === stalwartAccountId
  );
  return row ?? null;
}

export function extractAccountEmailAliases(
  res: unknown,
  stalwartAccountId: string
): Map<string, StalwartEmailAlias> {
  const row = extractAccountRecordById(res, stalwartAccountId);
  const aliases = row?.aliases;
  const map = new Map<string, StalwartEmailAlias>();
  if (!aliases || typeof aliases !== "object") return map;

  for (const [index, value] of Object.entries(aliases as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const alias = value as StalwartEmailAlias;
    if (typeof alias.name !== "string" || typeof alias.domainId !== "string") continue;
    map.set(index, alias);
  }
  return map;
}

function findAccountAliasIndex(
  aliases: Map<string, StalwartEmailAlias>,
  localPart: string,
  domainId: string
): string | null {
  for (const [index, alias] of aliases) {
    if (alias.name === localPart && alias.domainId === domainId) return index;
  }
  return null;
}

export async function addAccountEmailAlias(
  stalwartAccountId: string,
  aliasEmail: string,
  domainId: string
) {
  const localPart = parseEmailLocalPart(aliasEmail);
  const accountRes = await getAccount(stalwartAccountId);
  if (isStalwartFailure(accountRes)) return accountRes;

  const aliases = extractAccountEmailAliases(accountRes, stalwartAccountId);
  if (findAccountAliasIndex(aliases, localPart, domainId) !== null) {
    return accountRes;
  }

  const numericKeys = [...aliases.keys()].map((k) => Number.parseInt(k, 10)).filter(Number.isFinite);
  const nextIndex = numericKeys.length > 0 ? Math.max(...numericKeys) + 1 : 0;

  return jmapCall([
    [
      "x:Account/set",
      {
        update: {
          [stalwartAccountId]: {
            [`aliases/${nextIndex}`]: {
              name: localPart,
              domainId,
              enabled: true,
            },
          },
        },
      },
      "u1",
    ],
  ]);
}

export async function removeAccountEmailAlias(
  stalwartAccountId: string,
  aliasEmail: string,
  domainId: string
) {
  const localPart = parseEmailLocalPart(aliasEmail);
  const accountRes = await getAccount(stalwartAccountId);
  if (isStalwartFailure(accountRes)) return accountRes;

  const aliases = extractAccountEmailAliases(accountRes, stalwartAccountId);
  const index = findAccountAliasIndex(aliases, localPart, domainId);
  if (index === null) return accountRes;

  return jmapCall([
    [
      "x:Account/set",
      {
        update: {
          [stalwartAccountId]: {
            [`aliases/${index}`]: null,
          },
        },
      },
      "u1",
    ],
  ]);
}

type StalwartSendIdentity = { id: string; email?: string; name?: string };

function extractSendIdentities(res: unknown): StalwartSendIdentity[] {
  if (!res || typeof res !== "object" || !("methodResponses" in res)) return [];
  const body = (res as { methodResponses: unknown[][] }).methodResponses?.[0]?.[1];
  if (!body || typeof body !== "object" || !("list" in body)) return [];
  const list = (body as { list: unknown }).list;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (item): item is StalwartSendIdentity =>
      typeof item === "object" && item !== null && "id" in item
  );
}

export async function listAccountSendIdentities(stalwartAccountId: string) {
  return jmapCall(
    [["Identity/get", { accountId: stalwartAccountId }, "g1"]],
    15_000,
    JMAP_MAIL_USING
  );
}

export async function createAccountSendIdentity(
  stalwartAccountId: string,
  email: string,
  name?: string | null
) {
  const normalizedEmail = email.trim().toLowerCase();
  const createId = `identity-${Date.now()}`;
  return jmapCall(
    [
      [
        "Identity/set",
        {
          accountId: stalwartAccountId,
          create: {
            [createId]: {
              name: name?.trim() || normalizedEmail,
              email: normalizedEmail,
            },
          },
        },
        "c1",
      ],
    ],
    15_000,
    JMAP_MAIL_USING
  );
}

export async function deleteAccountSendIdentity(stalwartAccountId: string, identityId: string) {
  return jmapCall(
    [
      [
        "Identity/set",
        {
          accountId: stalwartAccountId,
          destroy: [identityId],
        },
        "d1",
      ],
    ],
    15_000,
    JMAP_MAIL_USING
  );
}

export function findSendIdentityIdByEmail(
  res: unknown,
  email: string
): string | null {
  const normalized = email.trim().toLowerCase();
  const match = extractSendIdentities(res).find((identity) => {
    const raw = identity.email?.trim().toLowerCase() ?? "";
    return raw === normalized || raw.endsWith(`<${normalized}>`);
  });
  return match?.id ?? null;
}

export async function resolveStalwartAccountId(
  stalwartAccountId: string | null,
  address: string
): Promise<{ id: string | null; unavailable: boolean }> {
  if (stalwartAccountId) return { id: stalwartAccountId, unavailable: false };

  const queryRes = await queryAccountByEmail(address);
  if (isStalwartFailure(queryRes)) return { id: null, unavailable: true };

  const ids = extractJmapQueryIds(queryRes);
  if (ids.length === 0) return { id: null, unavailable: false };
  if (ids.length === 1) return { id: ids[0], unavailable: false };

  const getRes = await jmapCall([["x:Account/get", { ids }, "g1"]]);
  if (isStalwartFailure(getRes)) return { id: null, unavailable: true };

  const match = extractAccountRecords(getRes).find((account) => account.emailAddress === address);
  return { id: match?.id ?? null, unavailable: false };
}

function asJmapResponses(res: unknown): unknown[][] {
  if (!res || typeof res !== "object" || !("methodResponses" in res)) return [];
  const responses = (res as { methodResponses: unknown[][] }).methodResponses;
  return Array.isArray(responses) ? responses : [];
}

function jmapSendError(res: unknown): string | null {
  if (isStalwartFailure(res)) {
    if (typeof res === "object" && res && "error" in res) return String((res as { error: string }).error);
    if (typeof res === "object" && res && "unavailable" in res) return "Stalwart JMAP indisponible";
  }
  for (const row of asJmapResponses(res)) {
    const name = String(row[0] ?? "");
    const body = row[1] as {
      type?: string;
      description?: string;
      notCreated?: Record<string, { type?: string; description?: string; properties?: string[] }>;
    };
    if (name.endsWith("/error") || name === "error") {
      return body?.description || body?.type || name;
    }
    const first = body?.notCreated ? Object.values(body.notCreated)[0] : undefined;
    if (first) {
      const props = first.properties?.length ? ` (${first.properties.join(", ")})` : "";
      return `${first.description || first.type || "notCreated"}${props}`;
    }
  }
  return null;
}

function emailsFromPayload(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseMailFrom(raw: string): { email: string; name?: string } {
  const trimmed = raw.trim();
  const angle = trimmed.match(/<([^>]+)>/);
  const email = (angle?.[1] ?? trimmed).trim().toLowerCase();
  const name = angle
    ? trimmed.replace(/<[^>]+>/, "").trim().replace(/^"|"$/g, "") || undefined
    : undefined;
  return { email, name };
}

/** Envoi via JMAP HTTPS (seul port joignable depuis K8s). Pas de TEM Scaleway. */
export async function sendMailViaStalwartJmap(input: {
  accountId: string;
  from: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
}): Promise<
  { ok: true; messageId: string; via: string } | { ok: false; code: "smtp_not_configured" | "send_failed"; detail?: string }
> {
  if (!STALWART_API_KEY) {
    return { ok: false, code: "smtp_not_configured", detail: "STALWART_API_KEY manquant" };
  }

  const { email: fromEmail, name: fromName } = parseMailFrom(input.from);
  const to = emailsFromPayload(input.to);
  if (!fromEmail || to.length === 0) {
    return { ok: false, code: "send_failed", detail: "From ou To invalide" };
  }

  const boxesRes = await jmapCall(
    [
      ["Mailbox/query", { accountId: input.accountId, filter: { role: "drafts" } }, "q1"],
      [
        "Mailbox/get",
        {
          accountId: input.accountId,
          "#ids": { resultOf: "q1", name: "Mailbox/query", path: "/ids" },
          properties: ["id", "role"],
        },
        "g1",
      ],
    ],
    15_000,
    JMAP_MAIL_USING
  );
  const boxes = asJmapResponses(boxesRes);
  const boxList = (boxes.find((row) => row[0] === "Mailbox/get")?.[1] as { list?: Array<{ id: string }> })
    ?.list;
  const draftsId = boxList?.[0]?.id;

  const identitiesRes = await listAccountSendIdentities(input.accountId);
  let identityId = isStalwartFailure(identitiesRes)
    ? null
    : findSendIdentityIdByEmail(identitiesRes, fromEmail);
  if (!identityId) {
    const created = await createAccountSendIdentity(input.accountId, fromEmail, fromName);
    identityId = extractStalwartCreatedId(created);
    if (!identityId) {
      const again = await listAccountSendIdentities(input.accountId);
      identityId = isStalwartFailure(again) ? null : findSendIdentityIdByEmail(again, fromEmail);
    }
  }
  if (!identityId) {
    return { ok: false, code: "send_failed", detail: "Identité d'envoi Stalwart introuvable." };
  }
  if (!draftsId) {
    return { ok: false, code: "send_failed", detail: "Boîte Brouillons introuvable" };
  }

  const draftKey = "e1";
  const emailCreate: Record<string, unknown> = {
    mailboxIds: { [draftsId]: true },
    from: [{ ...(fromName ? { name: fromName } : {}), email: fromEmail }],
    to: to.map((email) => ({ email })),
    subject: input.subject,
    keywords: { $seen: true, $draft: true },
  };
  const cc = emailsFromPayload(input.cc);
  const bcc = emailsFromPayload(input.bcc);
  if (cc.length) emailCreate.cc = cc.map((email) => ({ email }));
  if (bcc.length) emailCreate.bcc = bcc.map((email) => ({ email }));
  if (input.replyTo) emailCreate.replyTo = [{ email: input.replyTo }];
  if (input.html?.trim()) {
    emailCreate.bodyValues = {
      text: { value: input.text?.trim() || "" },
      html: { value: input.html },
    };
    emailCreate.textBody = [{ partId: "text", type: "text/plain" }];
    emailCreate.htmlBody = [{ partId: "html", type: "text/html" }];
  } else {
    emailCreate.bodyValues = { "1": { value: input.text ?? "" } };
    emailCreate.textBody = [{ partId: "1", type: "text/plain" }];
  }

  const sendRes = await jmapCall(
    [
      ["Email/set", { accountId: input.accountId, create: { [draftKey]: emailCreate } }, "e1"],
      [
        "EmailSubmission/set",
        {
          accountId: input.accountId,
          create: {
            s1: {
              emailId: `#${draftKey}`,
              identityId,
            },
          },
        },
        "s1",
      ],
    ],
    20_000,
    JMAP_MAIL_USING
  );

  const sendErr = jmapSendError(sendRes);
  if (sendErr) {
    return { ok: false, code: "send_failed", detail: sendErr };
  }

  const createdSub = (
    asJmapResponses(sendRes).find((row) => row[0] === "EmailSubmission/set")?.[1] as {
      created?: Record<string, { id?: string }>;
    }
  )?.created?.s1?.id;
  const createdEmail = (
    asJmapResponses(sendRes).find((row) => row[0] === "Email/set")?.[1] as {
      created?: Record<string, { id?: string }>;
    }
  )?.created?.[draftKey]?.id;

  return {
    ok: true,
    messageId: createdSub || createdEmail || "unknown",
    via: "stalwart-jmap",
  };
}

export function getMailConfig() {
  const base = getStalwartJmapUrl() || STALWART_URL;
  const host = base.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return {
    imapServer: host,
    smtpServer: host,
    imapPort: 993,
    smtpPort: 587,
    smtpPortSsl: 465,
    webmailUrl: process.env.WEBMAIL_URL ?? "",
  };
}

/** URL JMAP Stalwart (API admin + auth OAuth portail). Bulwark (WEBMAIL_URL) n'expose pas JMAP. */
export function getStalwartJmapUrl(): string {
  const url = STALWART_URL.replace(/\/$/, "");
  assertHttpsServiceUrl(url, "STALWART_URL");
  return url;
}

/** URL webmail externe (Bulwark, nouvel onglet). */
export function getWebmailExternalUrl(): string {
  const url = (process.env.WEBMAIL_URL || STALWART_URL).replace(/\/$/, "");
  assertHttpsServiceUrl(url, "WEBMAIL_URL");
  return url;
}

/** JMAP same-origin Bulwark (nginx webmail → Stalwart). Évite CORS navigateur. */
export function getBulwarkJmapUrl(): string {
  return getWebmailExternalUrl();
}

/** Public DKIM material only; private signing keys never leave Stalwart. */
export async function getDomainDkimRecords(fqdn: string): Promise<{
  records: { type: string; name: string; value: string }[];
  available: boolean;
  signingEnabled: boolean | null;
}> {
  const domain = await resolveStalwartDomainId(fqdn, null);
  if (!domain.id) return { records: [], available: false, signingEnabled: null };
  const query = await jmapCall([["x:DkimSignature/query", { filter: { domainId: domain.id } }, "q"]]);
  if (isStalwartFailure(query)) return { records: [], available: false, signingEnabled: null };
  const ids = extractJmapQueryIds(query);
  if (!ids.length) return { records: [], available: false, signingEnabled: null };
  const result = await jmapCall([["x:DkimSignature/get", {
    ids, properties: ["domainId", "selector", "publicKey", "stage", "@type"],
  }, "g"], ["x:SenderAuth/get", { ids: ["singleton"], properties: ["dkimSignDomain"] }, "signing"]]);
  if (isStalwartFailure(result)) return { records: [], available: false, signingEnabled: null };
  const body = firstMethodResponse(result)?.[1] as { list?: {
    domainId: string; selector: string; publicKey: string; stage: string; "@type": string;
  }[] } | undefined;
  const records = (body?.list ?? []).filter(key =>
    key.domainId === domain.id && key.stage === "active" && key.publicKey &&
    ["Dkim1RsaSha256", "Dkim1Ed25519Sha256"].includes(key["@type"])
  ).map(key => ({
    type: "TXT", name: `${key.selector}._domainkey.${fqdn}`,
    value: `v=DKIM1; k=${key["@type"] === "Dkim1RsaSha256" ? "rsa" : "ed25519"}; p=${key.publicKey}`,
  }));
  const responses = (result as { methodResponses?: unknown[][] }).methodResponses;
  const policy = (responses?.[1]?.[1] as { list?: { dkimSignDomain?: unknown }[] } | undefined)?.list?.[0]?.dkimSignDomain;
  const expected = { match: { "0": { if: "is_local_domain(sender_domain) && !is_empty(authenticated_as)", then: "sender_domain" } }, else: "false" };
  const signingEnabled = policy === "sender_domain" || JSON.stringify(policy) === JSON.stringify(expected)
    ? true : policy === false || policy === "false" ? false : null;
  return { records, available: records.some(record => record.value.includes("k=rsa")), signingEnabled };
}
