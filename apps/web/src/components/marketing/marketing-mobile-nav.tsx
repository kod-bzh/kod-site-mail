"use client";

import Link from "next/link";
import { Menu, X, ArrowUpRight } from "lucide-react";
import { useRef } from "react";
import type { SolutionMenuItem } from "./solutions-menu";

export function MarketingMobileNav({ links, label, solutionsLabel, solutions }: {
  links: { href: string; label: string }[];
  label: string;
  solutionsLabel: string;
  solutions: SolutionMenuItem[];
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const close = () => { if (menu.current) menu.current.open = false; };
  return (
    <details ref={menu} className="group lg:hidden" onKeyDown={(event) => {
      if (event.key === "Escape" && menu.current) {
        close();
        menu.current.querySelector("summary")?.focus();
      }
    }}>
      <summary aria-label={label} className="flex size-11 cursor-pointer list-none items-center justify-center rounded-md border border-canal [&::-webkit-details-marker]:hidden">
        <Menu className="size-5 group-open:hidden" aria-hidden />
        <X className="hidden size-5 group-open:block" aria-hidden />
      </summary>
      <nav aria-label={label} className="absolute inset-x-0 top-full max-h-[calc(100dvh-6rem)] overflow-y-auto border-b border-canal bg-creme p-6 shadow-sm">
        {links.map((link) => (
          <Link key={link.href} href={link.href} className="block rounded-md px-3 py-3 text-sm hover:bg-encre-muted hover:text-encre" onClick={close}>{link.label}</Link>
        ))}
        <p className="brand-eyebrow mt-4 border-t border-canal px-3 pt-5 text-ardoise/60">{solutionsLabel}</p>
        {solutions.map(({ key, href, name, description }) => (
          <Link key={key} href={href} onClick={close} className="mt-2 flex items-center justify-between gap-3 rounded-lg px-3 py-3 hover:bg-encre-muted">
            <span><span className="block text-sm font-semibold text-encre">{name}</span><span className="mt-1 block text-xs text-ardoise/60">{description}</span></span>
            <ArrowUpRight className="size-4 shrink-0 text-encre" aria-hidden />
          </Link>
        ))}
      </nav>
    </details>
  );
}
