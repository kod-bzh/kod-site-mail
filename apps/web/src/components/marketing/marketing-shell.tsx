import Link from "next/link";
import { kodAssoUrl } from "@/lib/solution-urls";
import { ArrowUpRight } from "lucide-react";
import { BrandLogo } from "@/components/layout/brand-logo";
import { getT } from "@/i18n/t";
import { MarketingMobileNav } from "./marketing-mobile-nav";
import { SolutionsMenu, type SolutionMenuItem } from "./solutions-menu";

export async function MarketingShell({ children }: { children: React.ReactNode }) {
  const t = await getT("association");
  const tc = await getT("common");
  const links = [
    { href: "/#manifeste", label: t("nav.manifesto") },
    { href: "/#engagements", label: t("nav.missions") },
    { href: "/#pour-qui", label: t("nav.audiences") },
  ];
  const solutions: SolutionMenuItem[] = [
    { key: "mail", href: "/solutions/mail", name: "Kod Mail", description: t("solutions.mail.summary") },
    { key: "asso", href: kodAssoUrl(), name: "Kod Asso", description: t("solutions.asso.summary") },
  ];
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-encre focus:px-4 focus:py-2 focus:text-white">{tc("skipToContent")}</a>
      <header className="sticky top-0 z-40 border-b border-canal/70 bg-creme/95 backdrop-blur-sm">
        <div className="relative mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <BrandLogo alt={tc("appName")} href="/" size="sm" className="shrink-0" />
          <nav className="hidden items-center gap-8 lg:flex" aria-label={t("footer.nav")}>
            {links.slice(0, 2).map((link) => <Link key={link.href} href={link.href} className="text-sm font-medium text-ardoise/80 hover:text-encre">{link.label}</Link>)}
            <SolutionsMenu label={t("nav.solutions")} solutions={solutions} />
            <Link href={links[2].href} className="text-sm font-medium text-ardoise/80 hover:text-encre">{links[2].label}</Link>
          </nav>
          <MarketingMobileNav label={t("footer.nav")} links={links} solutionsLabel={t("nav.solutions")} solutions={solutions} />
        </div>
      </header>
      <main id="main-content" className="flex-1">{children}</main>
      <footer className="bg-ardoise px-6 pt-16 pb-8 text-creme">
        <div className="mx-auto max-w-6xl">
          <div className="grid gap-12 sm:grid-cols-[1.5fr_1fr_1fr]">
            <div>
              <BrandLogo alt={tc("appName")} href="/" tone="white" />
              <p className="mt-6 max-w-xs text-sm leading-relaxed text-creme/65">{t("footer.mission")}</p>
              <p className="brand-eyebrow mt-5 text-[#a5a2ff]">{t("footer.tagline")}</p>
            </div>
            <div>
              <p className="brand-eyebrow text-creme/50">{t("footer.nav")}</p>
              <ul className="mt-5 space-y-4 text-sm text-creme/85">
                {links.map((link) => <li key={link.href}><Link href={link.href} className="hover:underline">{link.label}</Link></li>)}
                <li><a href="https://github.com/kod-digor/kod-site-mail" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 hover:underline">{t("hero.ctaSource")}<ArrowUpRight className="size-3.5" aria-hidden /></a></li>
              </ul>
            </div>
            <div>
              <p className="brand-eyebrow text-creme/50">{t("nav.solutions")}</p>
              <ul className="mt-5 space-y-4 text-sm text-creme/85">
                {solutions.map((solution) => <li key={solution.key}><Link href={solution.href} className="hover:underline">{solution.name}</Link></li>)}
              </ul>
            </div>
          </div>
          <div className="mt-14 flex flex-wrap justify-between gap-4 border-t border-creme/15 pt-6 font-mono-data text-xs text-creme/55"><span>{t("footer.location")}</span><span>{t("footer.values")}</span></div>
        </div>
      </footer>
    </div>
  );
}
