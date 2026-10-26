import Link from "next/link";
import { kodAssoUrl } from "@/lib/solution-urls";
import { ArrowUpRight, Mail, Users } from "lucide-react";
import { getT } from "@/i18n/t";

const SOLUTIONS = [
  { key: "mail", name: "Kod Mail", icon: Mail },
  { key: "asso", name: "Kod Asso", icon: Users },
] as const;

export async function ProductShowcase() {
  const t = await getT("association");
  return (
    <section id="solutions" className="border-y border-canal bg-paper px-6 py-20">
      <div className="mx-auto max-w-6xl">
        <p className="brand-eyebrow text-ardoise/60">{t("nav.solutions")}</p>
        <div className="mt-5 flex flex-wrap items-end justify-between gap-6">
          <h2 className="brand-heading text-5xl sm:text-6xl">{t("products.headline")}</h2>
          <p className="max-w-sm text-sm leading-relaxed text-ardoise/65">{t("products.subtitle")}</p>
        </div>
        <ul className="mt-12 grid gap-5 sm:grid-cols-2">
          {SOLUTIONS.map(({ key, name, icon: Icon }) => (
            <li key={key}>
              <Link href={key === "asso" ? kodAssoUrl() : "/solutions/mail"} className="group flex h-full flex-col rounded-xl border border-canal p-7 transition-colors hover:border-encre/30 hover:bg-encre-muted/30 sm:p-8">
                <div className="flex items-center justify-between gap-4">
                  <span className="flex size-12 items-center justify-center rounded-lg bg-encre-muted"><Icon className="size-6 text-encre" aria-hidden /></span>
                  <span className="rounded-full bg-encre-muted px-3 py-1 text-xs font-medium text-encre">{t(`solutions.${key}.status`)}</span>
                </div>
                <h3 className="brand-heading mt-8 text-4xl sm:text-5xl">{name}</h3>
                <p className="mt-4 text-base leading-relaxed text-ardoise/70">{t(`solutions.${key}.description`)}</p>
                <span className="mt-8 inline-flex items-center gap-2 text-sm font-semibold text-encre">{t("solutions.discover")}<ArrowUpRight className="size-4" aria-hidden /></span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
