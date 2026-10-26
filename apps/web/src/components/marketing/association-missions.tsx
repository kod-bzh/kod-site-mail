import { Code2, HandCoins, Server, Megaphone } from "lucide-react";
import { getT } from "@/i18n/t";

const MISSIONS = [
  { key: "develop", icon: Code2 },
  { key: "finance", icon: HandCoins },
  { key: "host", icon: Server },
  { key: "share", icon: Megaphone },
] as const;

export async function AssociationMissions() {
  const t = await getT("association");
  return (
    <section id="engagements" className="px-6 py-20">
      <div className="mx-auto max-w-6xl">
        <p className="brand-eyebrow text-ardoise/60">{t("missions.eyebrow")}</p>
        <div className="mt-5 flex flex-wrap items-end justify-between gap-6">
          <h2 className="brand-heading text-5xl sm:text-6xl">{t("missions.title")}</h2>
          <p className="max-w-sm text-sm leading-relaxed text-ardoise/65">{t("missions.subtitle")}</p>
        </div>
        <ul className="mt-12 grid gap-4 sm:grid-cols-2">
          {MISSIONS.map(({ key, icon: Icon }) => (
            <li key={key} className="flex gap-5 rounded-xl border border-canal bg-paper p-6 sm:p-8">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-encre-muted"><Icon className="size-6 text-encre" aria-hidden /></div>
              <div>
                <h3 className="brand-heading text-3xl">{t(`missions.${key}.title`)}</h3>
                <p className="mt-3 text-sm leading-relaxed text-ardoise/65">{t(`missions.${key}.description`)}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
