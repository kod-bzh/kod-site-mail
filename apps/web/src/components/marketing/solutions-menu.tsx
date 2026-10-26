"use client";

import Link from "next/link";
import { Mail, Users, ChevronDown, ArrowUpRight } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";

export type SolutionMenuItem = { key: "mail" | "asso"; href: string; name: string; description: string };

export function SolutionsMenu({ label, solutions }: { label: string; solutions: SolutionMenuItem[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-sm py-2 text-sm font-medium text-ardoise/80 hover:text-encre data-[state=open]:text-encre">
        {label}<ChevronDown className="size-4" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={16} className="w-80 rounded-xl border-canal bg-paper p-2 text-ardoise shadow-sm">
        {solutions.map(({ key, href, name, description }) => {
          const Icon = key === "mail" ? Mail : Users;
          return (
            <DropdownMenuItem key={key} asChild className="rounded-lg p-4 focus:bg-encre-muted/50">
              <Link href={href} className="group flex gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-encre-muted text-encre"><Icon className="size-5" aria-hidden /></span>
                <span className="flex-1"><span className="block font-semibold">{name}</span><span className="mt-1 block text-xs leading-relaxed text-ardoise/60">{description}</span></span>
                <ArrowUpRight className="size-4 text-encre" aria-hidden />
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
