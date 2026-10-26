import { Building2, Home, Landmark, Users } from "lucide-react";
import { getT } from "@/i18n/t";

const AUDIENCES = [
  { key: "family", icon: Home, descKey: "familyDesc" },
  { key: "association", icon: Users, descKey: "associationDesc" },
  { key: "business", icon: Building2, descKey: "businessDesc" },
  { key: "collectivity", icon: Landmark, descKey: "collectivityDesc" },
] as const;

export async function AudienceStrip() {
  const t = await getT("association");
  return (
    <section id="pour-qui" className="px-6 py-20">
      <div className="mx-auto max-w-6xl">
        <p className="brand-eyebrow text-ardoise/60">{t("audiences.title")}</p>
        <h2 className="brand-heading mt-5 max-w-3xl text-5xl sm:text-6xl">{t("audiences.headline")}</h2>
        <ul className="mt-12 grid border-t border-canal sm:grid-cols-2 lg:grid-cols-4">
          {AUDIENCES.map(({ key, icon: Icon, descKey }) => (
            <li key={key} className="px-1 py-8 sm:pr-6 lg:not-first:border-l lg:not-first:border-canal lg:not-first:pl-6">
              <Icon className="size-7 text-encre" strokeWidth={1.6} aria-hidden />
              <h3 className="brand-heading mt-5 text-3xl">{t(`audiences.${key}`)}</h3>
              <p className="mt-3 text-sm leading-relaxed text-ardoise/65">{t(`audiences.${descKey}`)}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
