import Link from "next/link";
import { Mail, FolderOpen, Calendar, Sparkles } from "lucide-react";
import { getT } from "@/i18n/t";

export async function SchematicSection() {
  const t = await getT("association");

  const nodes = [
    { icon: Mail, label: t("schematic.mail"), href: "/roadmap/mail" },
    { icon: FolderOpen, label: t("schematic.drive"), href: "/roadmap/drive" },
    { icon: Calendar, label: t("schematic.calendar"), href: "/roadmap/calendar" },
    { icon: Sparkles, label: t("schematic.more"), href: "/roadmap" },
  ];

  return (
    <section className="border-y border-canal bg-paper px-6 py-16">
      <div className="mx-auto max-w-4xl text-center">
        <h2 className="text-xl font-semibold text-ardoise">{t("schematic.title")}</h2>
        <div className="mt-8 flex flex-col items-center gap-6">
          <div className="rounded-xl border-2 border-encre bg-encre-muted px-8 py-4">
            <span className="font-medium text-encre">{t("schematic.domain")}</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {nodes.map(({ icon: Icon, label, href }) => (
              <Link
                key={label}
                href={href}
                className="flex items-center gap-2 rounded-lg border border-canal bg-paper px-4 py-2 text-sm text-ardoise/80 transition-colors hover:border-encre/30 hover:text-encre"
              >
                <Icon className="size-4 text-encre" aria-hidden />
                {label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
