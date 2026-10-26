export const SOLUTION_KEYS = ["mail", "asso"] as const;
export type SolutionKey = (typeof SOLUTION_KEYS)[number];
export type AuthMode = "login" | "signup";

export function getSolutionKey(value: unknown): SolutionKey | null {
  return value === "mail" || value === "asso" ? value : null;
}

/** Only known solution keys can choose an authentication return page. */
export function authEntryUrl(
  solution: SolutionKey | null,
  mode: AuthMode,
  options: { error?: string; callbackUrl?: string } = {},
): string {
  const path = solution ? `/solutions/${solution}` : mode === "signup" ? "/signup" : "/login";
  const query = new URLSearchParams();
  if (solution && mode === "signup") query.set("mode", "signup");
  if (options.error) query.set("error", options.error);
  if (options.callbackUrl?.startsWith("/") && !options.callbackUrl.startsWith("//")) {
    query.set("callbackUrl", options.callbackUrl);
  }
  return query.size ? `${path}?${query}` : path;
}
