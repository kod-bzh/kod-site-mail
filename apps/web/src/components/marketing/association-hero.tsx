import Link from "next/link";
import { ArrowUpRight, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getT } from "@/i18n/t";

export async function AssociationHero() {
  const t = await getT("association");

  return (
    <section className="overflow-hidden px-6 pt-14 pb-20 sm:pt-20 sm:pb-24">
      <div className="mx-auto max-w-6xl">
        <p className="brand-eyebrow text-encre">{t("hero.eyebrow")}</p>
        <h1 className="brand-heading mt-8 max-w-5xl text-[clamp(3.5rem,8.5vw,7.25rem)]">
          {t("hero.title")}<br />
          {t("hero.titleJoin")} <span className="text-encre">{t("hero.titleAccent")}</span>
          <span className="ml-2 align-top font-mono-data text-[0.22em] leading-[2] text-encre" aria-hidden>&lt;/&gt;</span>
        </h1>
        <div className="mt-10 grid items-end gap-8 lg:mt-12 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
          <p className="max-w-xl text-lg leading-relaxed text-ardoise/80 sm:text-xl">
            {t("hero.subtitle")}
          </p>
          <div>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg" className="h-13 rounded-full px-6 text-sm">
                <Link href="#solutions">{t("hero.ctaSignup")}<ArrowUpRight className="size-4" aria-hidden /></Link>
              </Button>
              <Button asChild variant="outline" size="lg" className="h-13 rounded-full px-6 text-sm">
                <a href="https://github.com/kod-digor/kod-site-mail" target="_blank" rel="noreferrer">
                  <GitBranch className="size-4" aria-hidden />{t("hero.ctaSource")}
                </a>
              </Button>
            </div>
            <p className="mt-4 font-mono-data text-xs leading-relaxed text-ardoise/60">{t("hero.note")}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
