/** Public entry point for the standalone Kod Asso application. */
export function kodAssoUrl(): string {
  return (process.env.KOD_ASSO_URL || "https://asso.kod.bzh").replace(/\/$/, "");
}
