import Image from "next/image";
import { ShieldCheck, LockKeyhole, Unlock, HeartHandshake } from "lucide-react";
import { getT } from "@/i18n/t";

const POINTS = [
  { key: "pointSovereign", icon: ShieldCheck },
  { key: "pointEncrypted", icon: LockKeyhole },
  { key: "pointNoLockIn", icon: Unlock },
  { key: "pointNonProfit", icon: HeartHandshake },
] as const;

export async function EcosystemComparison() {
  const t = await getT("association");
  return (
    <section className="relative overflow-hidden bg-encre px-6 py-20 text-creme">
      <Image src="/brand/kod-bzh/logos/kod-bzh-stacked-white.png" alt="" aria-hidden width={791} height={1136}
        className="pointer-events-none absolute right-0 -bottom-12 h-96 w-auto opacity-[0.08]" />
      <div className="relative mx-auto max-w-6xl">
        <p className="brand-eyebrow text-creme/70">{t("comparison.title")}</p>
        <h2 className="brand-heading mt-8 max-w-4xl text-4xl leading-[1.08] sm:text-5xl lg:text-6xl">{t("comparison.statement")}</h2>
        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {POINTS.map(({ key, icon: Icon }) => (
            <li key={key} className="rounded-lg border border-creme/25 bg-creme/5 p-6">
              <Icon className="size-6 text-creme" strokeWidth={1.6} aria-hidden />
              <p className="mt-5 text-sm leading-relaxed">{t(`comparison.${key}`)}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
