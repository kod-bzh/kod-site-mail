import Link from "next/link";
import { kodAssoUrl } from "@/lib/solution-urls";
import type { LucideIcon } from "lucide-react";
import { ArrowLeft, ArrowUpRight, Mail, Globe, Users, Inbox, CalendarDays, CreditCard, ShieldCheck, HeartHandshake } from "lucide-react";
import { loginAction, signupAction } from "@/app/actions/auth";
import { BrandLogo } from "@/components/layout/brand-logo";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getT } from "@/i18n/t";
import { getPlatformEmailDomains } from "@/lib/platform-domains";
import { formatSignupPriceEur, isPayplugConfigured } from "@/lib/billing/payplug";
import { authEntryUrl, type AuthMode, type SolutionKey } from "@/lib/solution-access";
import { AuthEmailField } from "./auth-email-field";
import { AuthSubmitButton } from "./auth-submit-button";

export type SolutionAccessParams = { mode?: string; error?: string; callbackUrl?: string };

const FEATURE_ICONS: Record<SolutionKey, LucideIcon[]> = {
  mail: [Globe, Users, Inbox, ShieldCheck],
  asso: [Users, CreditCard, CalendarDays, HeartHandshake],
};

export async function SolutionAccessPage({ solution, mode = "login", params = {}, contextual = true }: {
  solution: SolutionKey;
  mode?: AuthMode;
  params?: SolutionAccessParams;
  contextual?: boolean;
}) {
  const t = await getT("solutionAccess");
  const ta = await getT("auth");
  const tc = await getT("common");
  const signup = mode === "signup";
  const key = contextual ? solution : null;
  const name = solution === "mail" ? "Kod Mail" : "Kod Asso";
  const Icon = solution === "mail" ? Mail : Users;
  const paymentConfigured = isPayplugConfigured();
  const callbackUrl = typeof params.callbackUrl === "string" ? params.callbackUrl : "";
  const error = params.error === "invalid" ? t("invalidCredentials")
    : params.error === "db" ? t("unavailable")
    : params.error === "session" ? t("sessionExpired") : null;
  const linkOptions = { callbackUrl };

  return (
    <div className="min-h-screen bg-creme">
      <header className="border-b border-canal px-6 py-4">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4">
          <BrandLogo alt={tc("appName")} href="/" size="sm" />
          <Link href="/#solutions" className="inline-flex items-center gap-2 text-sm text-ardoise/65 hover:text-encre"><ArrowLeft className="size-4" aria-hidden />{t("backToSite")}</Link>
        </div>
      </header>
      <main className="mx-auto grid min-h-[calc(100dvh-85px)] max-w-[1600px] lg:grid-cols-[1fr_1.1fr]">
        <section aria-labelledby="access-title" className="flex items-center justify-center px-6 py-12 sm:px-10 lg:py-16">
          <div className="w-full max-w-md">
            <div className="inline-flex items-center gap-2 rounded-full border border-canal px-3 py-1.5 text-xs font-medium text-encre"><Icon className="size-3.5" aria-hidden />{name}</div>
            <h1 id="access-title" className="brand-heading mt-6 text-5xl sm:text-6xl">{signup ? t("signupTitle") : t("loginTitle")}</h1>
            <p className="mt-4 text-sm leading-relaxed text-ardoise/65">{t(signup ? "signupIntro" : "loginIntro", { name })}</p>
            <nav aria-label={t("accountNavigation")} className="mt-8 grid grid-cols-2 rounded-lg border border-canal bg-creme-deep p-1 text-center text-sm">
              {(["login", "signup"] as const).map((tab) => (
                <Link key={tab} href={authEntryUrl(key, tab, linkOptions)} aria-current={mode === tab ? "page" : undefined}
                  className={`rounded-md px-3 py-2.5 font-medium ${mode === tab ? "bg-paper text-encre shadow-xs" : "text-ardoise/60 hover:text-encre"}`}>
                  {t(tab === "login" ? "loginTab" : "signupTab")}
                </Link>
              ))}
            </nav>
            {error && <p role="alert" className="mt-6 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
            {solution === "asso" && <p className="mt-6 rounded-lg border border-canal bg-paper p-3 text-xs leading-relaxed text-ardoise/65">{t("asso.accountNote")}</p>}
            <form action={signup ? signupAction : loginAction} className="mt-6 space-y-5">
              {key && <input type="hidden" name="solution" value={key} />}
              {callbackUrl && <input type="hidden" name="callbackUrl" value={callbackUrl} />}
              {signup && <div><Label htmlFor="orgName">{solution === "asso" ? t("associationName") : ta("orgName")}</Label><Input id="orgName" name="orgName" required minLength={2} autoComplete="organization" className="mt-2 h-12" /></div>}
              {signup && solution === "mail" ? <AuthEmailField domains={getPlatformEmailDomains()} /> : (
                <div><Label htmlFor="email">{ta("email")}</Label><Input id="email" name="email" type="email" autoComplete={signup ? "email" : "username"} spellCheck={false} required className="mt-2 h-12" /></div>
              )}
              <div><Label htmlFor="password">{ta("password")}</Label><Input id="password" name="password" type="password" required minLength={signup ? 8 : undefined} autoComplete={signup ? "new-password" : "current-password"} className="mt-2 h-12" />{signup && <p className="mt-2 text-xs text-ardoise/55">{t("passwordHint")}</p>}</div>
              {signup && <div className="space-y-2 text-xs leading-relaxed text-ardoise/60">
                {paymentConfigured ? <><p>{ta("signupBillingHint")}</p><p>{ta("signupPriceHint", { price: formatSignupPriceEur() })}</p></> : <p>{t("activationNote")}</p>}
              </div>}
              <AuthSubmitButton label={signup ? paymentConfigured ? ta("signupSubmit") : t("signupSubmit") : t("loginTab")} pendingLabel={t("pending")} />
            </form>
            <p className="mt-6 text-center text-xs leading-relaxed text-ardoise/50">{t("accountNote")}</p>
          </div>
        </section>
        <aside aria-label={t("presentation", { name })} className="relative overflow-hidden bg-encre px-6 py-12 text-creme sm:px-10 lg:py-16">
          <div className="relative mx-auto flex h-full max-w-lg flex-col justify-center">
            <p className="brand-eyebrow text-creme/65">{t("tagline")}</p>
            <div className="mt-10 flex items-center gap-3"><Icon className="size-7" strokeWidth={1.6} aria-hidden /><p className="text-xl font-semibold">{name}</p></div>
            <h2 className="brand-heading mt-5 text-5xl sm:text-6xl lg:text-7xl">{t(`${solution}.headline`)}</h2>
            <p className="mt-6 max-w-md text-base leading-relaxed text-creme/75">{t(`${solution}.description`)}</p>
            <ul className="mt-10 grid gap-x-7 gap-y-7 sm:grid-cols-2">
              {([0, 1, 2, 3] as const).map((index) => {
                const FeatureIcon = FEATURE_ICONS[solution][index];
                return (
                <li key={index} className="border-t border-creme/25 pt-5">
                  <FeatureIcon className="size-5 text-creme/85" strokeWidth={1.6} aria-hidden />
                  <h3 className="mt-3 text-sm font-semibold">{t(`${solution}.features.${index}.title`)}</h3>
                  <p className="mt-2 text-xs leading-relaxed text-creme/65">{t(`${solution}.features.${index}.description`)}</p>
                </li>
              );
              })}
            </ul>
            <div className="mt-10 flex flex-wrap gap-4 border-t border-creme/25 pt-6 font-mono-data text-xs text-creme/65">
              <span>{t(`${solution}.status`)}</span>
              <Link href={solution === "mail" ? kodAssoUrl() : "/solutions/mail"} className="ml-auto inline-flex items-center gap-2 hover:text-creme">{t("otherSolution", { name: solution === "mail" ? "Kod Asso" : "Kod Mail" })}<ArrowUpRight className="size-3.5" aria-hidden /></Link>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
