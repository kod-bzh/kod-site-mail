import { beforeEach, describe, expect, it, vi } from "vitest";
const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { domain: { findUnique } } }));
vi.mock("@/lib/mail/outbound-smtp", () => ({ sendViaStalwartMailbox: vi.fn() }));
vi.mock("@/lib/stalwart/client", () => ({ resolveStalwartAccountId: vi.fn() }));
import { validateFromDomainForOrg } from "./org-mail-send";

beforeEach(() => vi.clearAllMocks());
describe("sending permission is separate from DNS readiness", () => {
  it("allows an authorized organization domain with DNS pending", async () => {
    findUnique.mockResolvedValue({ status: "PENDING_DNS" });
    expect(await validateFromDomainForOrg("org-a", "noreply@example.org")).toBeNull();
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId_fqdn: { organizationId: "org-a", fqdn: "example.org" } } }));
  });
  it("still refuses domains outside the authorized organization", async () => {
    findUnique.mockResolvedValue(null);
    expect(await validateFromDomainForOrg("org-a", "noreply@another.org")).toBe("domain_not_in_org");
  });
});
