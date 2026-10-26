import { Unlock, ShieldCheck, Users } from "lucide-react";
import { getT } from "@/i18n/t";

const VALUES = [
  { key: "freedom", icon: Unlock },
  { key: "sovereignty", icon: ShieldCheck },
  { key: "common", icon: Users },
] as const;

export async function ValuesGrid() {
  const t = await getT("association");
  return (
    <section id="manifeste" className="border-y border-canal bg-paper px-6 py-20">
      <div className="mx-auto max-w-6xl">
        <p className="brand-eyebrow text-ardoise/60">{t("values.title")}</p>
        <h2 className="brand-heading mt-8 max-w-5xl text-4xl sm:text-5xl lg:text-6xl">
          {t("values.manifestoStart")} <span className="text-encre">{t("values.manifestoAccent")}</span><br className="hidden sm:block" />
          <span className="text-ardoise/55"> {t("values.manifestoEnd")}</span>
        </h2>
        <ul className="mt-12 grid overflow-hidden rounded-xl border border-canal sm:grid-cols-3">
          {VALUES.map(({ key, icon: Icon }) => (
            <li key={key} className="border-canal p-7 not-first:border-t sm:not-first:border-t-0 sm:not-first:border-l">
              <div className="flex items-center gap-3">
                <Icon className="size-6 text-encre" aria-hidden />
                <h3 className="brand-heading text-3xl">{t(`values.${key}.title`)}</h3>
              </div>
              <p className="mt-6 border-t border-canal pt-5 text-sm leading-relaxed text-ardoise/70">{t(`values.${key}.description`)}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
