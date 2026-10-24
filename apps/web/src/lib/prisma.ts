import { Prisma, PrismaClient } from "@prisma/client";
import { loadDevEnv } from "../../load-dev-env";

loadDevEnv();

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaDatabaseUrl: string | undefined;
};

/** Delegates that must exist after `prisma generate` (stale dev singletons omit new models). */
const REQUIRED_DELEGATES = [
  "platformPricing",
  "userMailbox",
  "sharedMailboxMember",
  "mailboxDelegation",
  "mailboxFilter",
  "mailboxMigration",
  "migrationEvent",
  "organizationApiKey",
  "outboundMessage",
  "mailDeliveryEvent",
  "mailWebhook",
  "mailWebhookAttempt",
  "mailSuppression",
  "mailSendBudget",
  "mailMonitorState",
  "dmarcReport",
  "mailMonitoredDomain",
  "mailConnector",
  "mailObservation",
  "mailIncident",
  "mailTelemetryEvent",
  "mcpOAuthClient",
  "mcpOAuthAuthCode",
  "mcpOAuthAccessToken",
] as const;

/** Champs récents à vérifier sur le runtime embarqué (singleton dev avant `prisma generate`). */
const REQUIRED_MAILBOX_MIGRATION_FIELDS = [
  "sourceStatsJson",
  "scopeContacts",
  "scopeCalendar",
] as const satisfies readonly (keyof typeof Prisma.MailboxMigrationScalarFieldEnum)[];

const REQUIRED_MIGRATION_PHASES = [
  "SCANNING",
  "SYNCING_CONTACTS",
  "SYNCING_CALENDAR",
] as const;


type RuntimeDataModel = {
  models: Record<string, { fields: Array<{ name: string }> }>;
  enums: Record<string, { values: Array<{ name: string }> }>;
};

function resolveDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return url;

  if (/[?&]connection_limit=/.test(url)) return url;

  const limit = process.env.DATABASE_CONNECTION_LIMIT ?? "5";
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}connection_limit=${limit}&pool_timeout=20`;
}

function createPrismaClient() {
  const datasourceUrl = resolveDatabaseUrl();
  return new PrismaClient({
    ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

function hasDelegate(client: PrismaClient, key: string): boolean {
  const delegate = (client as unknown as Record<string, unknown>)[key];
  if (typeof delegate !== "object" || delegate === null) return false;
  return typeof (delegate as { findFirst?: unknown }).findFirst === "function";
}

function getRuntimeDataModel(client: PrismaClient): RuntimeDataModel | null {
  const runtime = (client as unknown as { _runtimeDataModel?: RuntimeDataModel })._runtimeDataModel;
  return runtime ?? null;
}

function clientHasMailboxMigrationSchema(client: PrismaClient): boolean {
  const runtime = getRuntimeDataModel(client);
  if (!runtime) return true;

  const fields = runtime.models.MailboxMigration?.fields ?? [];
  const fieldNames = new Set(fields.map((field) => field.name));
  if (!REQUIRED_MAILBOX_MIGRATION_FIELDS.every((name) => fieldNames.has(name))) {
    return false;
  }

  const phaseValues = new Set(
    (runtime.enums.MigrationPhase?.values ?? []).map((value) => value.name)
  );
  return REQUIRED_MIGRATION_PHASES.every((name) => phaseValues.has(name));
}

function isStalePrismaClient(client: PrismaClient): boolean {
  if (process.env.NODE_ENV !== "development") return false;

  if (REQUIRED_DELEGATES.some((key) => !hasDelegate(client, key))) {
    return true;
  }

  return !clientHasMailboxMigrationSchema(client);
}

function initPrismaClient(): PrismaClient {
  const currentDatabaseUrl = process.env.DATABASE_URL;
  const cached = globalForPrisma.prisma;

  const databaseUrlChanged =
    !!cached &&
    !!currentDatabaseUrl &&
    !!globalForPrisma.prismaDatabaseUrl &&
    globalForPrisma.prismaDatabaseUrl !== currentDatabaseUrl;

  if (cached && !isStalePrismaClient(cached) && !databaseUrlChanged) {
    return cached;
  }

  if (cached) {
    void cached.$disconnect().catch(() => {});
    globalForPrisma.prisma = undefined;
  }

  const client = createPrismaClient();
  globalForPrisma.prismaDatabaseUrl = currentDatabaseUrl;

  if (isStalePrismaClient(client)) {
    throw new Error(
      "Prisma client missing required model delegates. Run `pnpm exec prisma generate` in apps/web, then restart the dev server."
    );
  }

  globalForPrisma.prisma = client;

  return client;
}

/** Always resolves a client with required model delegates (recreates stale dev singletons). */
export function getPrisma(): PrismaClient {
  return initPrismaClient();
}

/**
 * Lazy proxy: every access re-validates the dev singleton so HMR cannot keep a stale
 * `const prisma` reference from a module loaded before a schema/client update.
 */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = initPrismaClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
