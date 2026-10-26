import Link from "next/link";
import { kodAssoUrl } from "@/lib/solution-urls";
import { ArrowUpRight, Mail, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getT } from "@/i18n/t";

export async function SignupCta() {
  const t = await getT("association");
  return (
    <section className="border-t border-canal px-6 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl text-center">
        <p className="brand-eyebrow text-encre">{t("cta.eyebrow")}</p>
        <h2 className="brand-heading mx-auto mt-6 max-w-4xl text-6xl sm:text-7xl lg:text-8xl">{t("cta.title")}</h2>
        <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-ardoise/65">{t("cta.subtitle")}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button asChild size="lg" className="h-13 rounded-full px-7"><Link href="/solutions/mail"><Mail className="size-4" aria-hidden />Kod Mail<ArrowUpRight className="size-4" aria-hidden /></Link></Button>
          <Button asChild size="lg" variant="outline" className="h-13 rounded-full px-7"><Link href={kodAssoUrl()}><Users className="size-4" aria-hidden />Kod Asso<ArrowUpRight className="size-4" aria-hidden /></Link></Button>
        </div>
      </div>
    </section>
  );
}
