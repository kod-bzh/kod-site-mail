import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractEmailAddress,
  isAdminMailTokenConfigured,
  isFromAddressAllowed,
  verifyAdminMailToken,
} from "@/lib/mail/admin-send";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.PLATFORM_DOMAINS = "kod.bzh,app.bzh";
  delete process.env.ADMIN_MAIL_TOKEN;
  delete process.env.ADMIN_MAIL_ALLOW_ANY_DOMAIN;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("verifyAdminMailToken", () => {
  it("refuse quand aucun token n'est configuré", () => {
    expect(isAdminMailTokenConfigured()).toBe(false);
    expect(verifyAdminMailToken("whatever")).toBe(false);
  });

  it("accepte le bon token, refuse les mauvais", () => {
    process.env.ADMIN_MAIL_TOKEN = "s3cr3t-token";
    expect(isAdminMailTokenConfigured()).toBe(true);
    expect(verifyAdminMailToken("s3cr3t-token")).toBe(true);
    expect(verifyAdminMailToken("wrong")).toBe(false);
    expect(verifyAdminMailToken("")).toBe(false);
    expect(verifyAdminMailToken(null)).toBe(false);
  });

  it("gère plusieurs tokens (rotation)", () => {
    process.env.ADMIN_MAIL_TOKEN = "old-token, new-token ";
    expect(verifyAdminMailToken("old-token")).toBe(true);
    expect(verifyAdminMailToken("new-token")).toBe(true);
    expect(verifyAdminMailToken("nope")).toBe(false);
  });
});

describe("extractEmailAddress", () => {
  it("extrait l'adresse d'un From nommé", () => {
    expect(extractEmailAddress("Bureau Kod Digor <contact@kod.bzh>")).toBe(
      "contact@kod.bzh"
    );
  });

  it("normalise une adresse simple", () => {
    expect(extractEmailAddress("  Contact@Kod.BZH ")).toBe(
      "contact@kod.bzh"
    );
  });

  it("rejette une entrée invalide", () => {
    expect(extractEmailAddress("pas-une-adresse")).toBeNull();
  });
});

describe("isFromAddressAllowed", () => {
  it("autorise une adresse d'un domaine plateforme, même non enregistrée", () => {
    expect(isFromAddressAllowed("nimporte-quoi@kod.bzh")).toBe(true);
    expect(isFromAddressAllowed("Asso <boite-inexistante@app.bzh>")).toBe(true);
  });

  it("autorise les sous-domaines d'un domaine plateforme", () => {
    expect(isFromAddressAllowed("noreply@mail.kod.bzh")).toBe(true);
  });

  it("refuse un domaine externe par défaut", () => {
    expect(isFromAddressAllowed("attaquant@gmail.com")).toBe(false);
  });

  it("autorise tout domaine si ADMIN_MAIL_ALLOW_ANY_DOMAIN=true", () => {
    process.env.ADMIN_MAIL_ALLOW_ANY_DOMAIN = "true";
    expect(isFromAddressAllowed("someone@gmail.com")).toBe(true);
  });

  it("refuse une adresse malformée", () => {
    expect(isFromAddressAllowed("pas-une-adresse")).toBe(false);
  });
});
