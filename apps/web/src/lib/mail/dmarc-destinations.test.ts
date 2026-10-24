import { expect, it } from "vitest";
import { ruaAddresses } from "./dmarc-destinations";
it("extracts bounded mailto RUA destinations without treating arbitrary URLs or injected headers as mailboxes", () => {
  expect(ruaAddresses("v=DMARC1; p=none; rua=mailto:dmarc@mail.d2-group.fr,mailto:reports@external.example!10m")).toEqual(["dmarc@mail.d2-group.fr", "reports@external.example"]);
  expect(ruaAddresses("v=DMARC1; rua=https://evil.test/,mailto:reports@example.net%0d%0aBcc:person@example.org")).toEqual([]);
});
