import { describe, expect, it } from "vitest";
import { dkimMatches, evaluateSpf, validDmarc, type AuthResolver } from "./authentication";

function resolver(txt: Record<string, string[]>): AuthResolver {
  return {
    resolveTxt: async name => (txt[name] ?? []).map(value => [value]),
    resolve4: async () => ["192.0.2.10"], resolve6: async () => [],
    resolveMx: async () => [{ exchange: "mail.example.org", priority: 10 }],
  };
}

describe("SPF sender authorization", () => {
  it("follows includes and accepts a merged SPF", async () => {
    const dns = resolver({ "example.org": ["v=spf1 include:other.test include:spf.test -all"], "other.test": ["v=spf1 ip4:203.0.113.1 -all"], "spf.test": ["v=spf1 ip4:192.0.2.0/24 -all"] });
    expect((await evaluateSpf("example.org", "192.0.2.10", dns)).ok).toBe(true);
  });
  it("rejects duplicates, substring impostors, negative includes and +all", async () => {
    for (const values of [["v=spf1 -all", "v=spf1 +all"], ["v=spf1 include:spf.test.evil -all"], ["v=spf1 -include:spf.test -all"], ["v=spf1 +all"]]) {
      const dns = resolver({ "example.org": values, "spf.test": ["v=spf1 ip4:192.0.2.10 -all"] });
      expect((await evaluateSpf("example.org", "192.0.2.10", dns)).ok).toBe(false);
    }
  });
  it("detects loops and lookup limit", async () => {
    expect((await evaluateSpf("a", "192.0.2.10", resolver({ a: ["v=spf1 include:a -all"] }))).ok).toBe(false);
    const records = Object.fromEntries(Array.from({ length: 12 }, (_, i) => ["d" + i, [i === 11 ? "v=spf1 ip4:192.0.2.10 -all" : `v=spf1 include:d${i + 1} -all`]]));
    expect((await evaluateSpf("d0", "192.0.2.10", resolver(records))).ok).toBe(false);
  });
  it("honors redirect and mechanism ordering", async () => {
    const dns = resolver({ a: ["v=spf1 redirect=b"], b: ["v=spf1 ip4:192.0.2.10 -all"], c: ["v=spf1 -all include:b"] });
    expect((await evaluateSpf("a", "192.0.2.10", dns)).ok).toBe(true);
    expect((await evaluateSpf("c", "192.0.2.10", dns)).ok).toBe(false);
  });
});

describe("DKIM and DMARC", () => {
  it("requires the active public key, tolerates tag order and rejects revoked keys", () => {
    const expected = "v=DKIM1; k=rsa; p=abcDEF";
    expect(dkimMatches("k=rsa; p=abcDEF; v=DKIM1", expected)).toBe(true);
    expect(dkimMatches("v=DKIM1; k=rsa; p=other", expected)).toBe(false);
    expect(dkimMatches("v=DKIM1; k=rsa; p=", expected)).toBe(false);
  });
  it("accepts existing stronger policies and rejects invalid or duplicate policies", () => {
    expect(validDmarc(["v=DMARC1; p=reject; adkim=s"]).ok).toBe(true);
    expect(validDmarc(["v=DMARC1; p=none"]).detail).toContain("observation");
    expect(validDmarc(["v=DMARC1; p=none", "v=DMARC1; p=reject"]).ok).toBe(false);
    expect(validDmarc(["v=DMARC1; p=invalid"]).ok).toBe(false);
  });
});
