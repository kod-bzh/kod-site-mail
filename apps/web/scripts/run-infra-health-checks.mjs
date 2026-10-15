#!/usr/bin/env node
/**
 * Smoke tests infrastructure (Stalwart JMAP, domaine plateforme, Bulwark, relais TEM).
 * Usage : depuis apps/web avec les variables prod (deploy/.generated/env.production).
 * Exit 0 si tous les checks bloquants passent ; 1 sinon.
 */
import { connect } from "node:net";

const platformDomain =
  process.env.PLATFORM_DOMAINS?.split(",")[0]?.trim().toLowerCase() ||
  process.env.PRIMARY_PLATFORM_DOMAIN?.trim().toLowerCase() ||
  "kod.bzh";

const stalwartUrl = (process.env.STALWART_URL || "").replace(/\/$/, "");
const webmailUrl = (process.env.WEBMAIL_URL || "").replace(/\/$/, "");
const apiKey = process.env.STALWART_API_KEY || "";
const relayHost = process.env.OUTBOUND_SMTP_RELAY_HOST || "";
const relayPort = Number(process.env.OUTBOUND_SMTP_RELAY_PORT || "2587");

const results = [];

function record(id, status, detail) {
  results.push({ id, status, detail });
  const tag = status === "ok" ? "OK  " : status === "warn" ? "WARN" : "FAIL";
  console.log(`${tag} ${id}${detail ? ` — ${detail}` : ""}`);
}

function checkTcp(host, port, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    const finish = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
    socket.on("timeout", () => finish(false));
  });
}

async function stalwartJmap(methodCalls) {
  const res = await fetch(`${stalwartUrl}/jmap`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
      methodCalls,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`JMAP HTTP ${res.status}`);
  }
  return res.json();
}

async function checkStalwartJmap() {
  if (!stalwartUrl || !apiKey) {
    record("infra-stalwart-jmap", "fail", "STALWART_URL ou STALWART_API_KEY manquant");
    return;
  }
  try {
    const data = await stalwartJmap([["x:Domain/query", { filter: {} }, "q1"]]);
    const first = data.methodResponses?.[0];
    if (first?.[0] === "error") {
      record("infra-stalwart-jmap", "fail", first[1]?.type ?? "JMAP error");
      return;
    }
    record("infra-stalwart-jmap", "ok", "x:Domain/query OK");
  } catch (err) {
    record("infra-stalwart-jmap", "fail", err instanceof Error ? err.message : String(err));
  }
}

async function checkPlatformDomain() {
  if (!stalwartUrl || !apiKey) {
    record("platform-domain", "fail", "Stalwart non configuré");
    return;
  }
  try {
    const data = await stalwartJmap([
      ["x:Domain/query", { filter: { text: platformDomain } }, "q1"],
      ["x:Domain/get", { ids: null, properties: ["name"] }, "g1"],
    ]);
    const ids = data.methodResponses?.[0]?.[1]?.ids ?? [];
    if (ids.length === 0) {
      record("platform-domain", "fail", `Domaine ${platformDomain} absent dans Stalwart`);
      return;
    }
    const list = data.methodResponses?.[1]?.[1]?.list ?? [];
    const names = list.map((d) => d.name).filter(Boolean);
    if (!names.includes(platformDomain)) {
      record("platform-domain", "fail", `Domaines Stalwart: ${names.join(", ") || "aucun"}`);
      return;
    }
    record("platform-domain", "ok", platformDomain);
  } catch (err) {
    record("platform-domain", "fail", err instanceof Error ? err.message : String(err));
  }
}

async function checkWebmailExternal() {
  if (!webmailUrl) {
    record("infra-mail-external", "warn", "WEBMAIL_URL non configuré");
    return;
  }
  try {
    const res = await fetch(webmailUrl, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 500) {
      record("infra-mail-external", "fail", `HTTP ${res.status}`);
      return;
    }
    record("infra-mail-external", "ok", `HTTP ${res.status}`);
  } catch (err) {
    record("infra-mail-external", "fail", err instanceof Error ? err.message : String(err));
  }
}

async function checkTemRelay() {
  if (!relayHost) {
    record("infra-tem-relay", "warn", "OUTBOUND_SMTP_RELAY non configuré");
    return;
  }
  const ok = await checkTcp(relayHost, relayPort);
  if (ok) {
    record("infra-tem-relay", "ok", `${relayHost}:${relayPort} accessible`);
  } else {
    record("infra-tem-relay", "fail", `${relayHost}:${relayPort} injoignable`);
  }
}

async function checkMailServer() {
  if (!stalwartUrl) {
    record("mail-server", "warn", "STALWART_URL non configuré");
    return;
  }
  let host;
  try {
    host = new URL(stalwartUrl).hostname;
  } catch {
    record("mail-server", "fail", "STALWART_URL invalide");
    return;
  }
  const smtp25 = await checkTcp(host, 25);
  if (smtp25) {
    record("mail-server", "ok", `SMTP :25 accessible (${host})`);
    return;
  }
  if (relayHost) {
    const relayOk = await checkTcp(relayHost, relayPort);
    if (relayOk) {
      record(
        "mail-server",
        "ok",
        `SMTP :25 fermé (Scaleway), relais TEM ${relayHost}:${relayPort} OK`
      );
      return;
    }
  }
  record("mail-server", "warn", `SMTP :25 fermé sur ${host}`);
}

await checkStalwartJmap();
await checkPlatformDomain();
await checkWebmailExternal();
await checkTemRelay();
await checkMailServer();

const failed = results.filter((r) => r.status === "fail");
if (failed.length > 0) {
  console.error(`\n${failed.length} échec(s) infrastructure`);
  process.exit(1);
}

console.log("\nInfra health checks passed");
process.exit(0);
