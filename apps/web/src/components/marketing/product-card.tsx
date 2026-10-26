"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getProductBySlug } from "@/lib/products-catalog";
import { useT } from "@/i18n/t";
import { productText, asStringTranslator } from "@/i18n/product-messages";
import { ProductStatusBadge } from "./product-status-badge";

type ProductCardProps = {
  slug: string;
};

export function ProductCard({ slug }: ProductCardProps) {
  const tp = asStringTranslator(useT("products"));
  const tr = useT("roadmap");
  const product = getProductBySlug(slug);
  if (!product) return null;
  const Icon = product.icon;

  const phaseCount = product.phases.length;
  const taskCount = product.phases.reduce((n, p) => n + p.tasks.length, 0);

  return (
    <Link
      href={`/roadmap/${product.slug}`}
      className="group flex flex-col rounded-xl border border-canal bg-paper p-5 transition-colors hover:border-encre/30 hover:bg-encre-muted/20"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-encre-muted">
          <Icon className="size-5 text-encre" aria-hidden />
        </div>
        <ProductStatusBadge status={product.status} />
      </div>
      <h3 className="mt-4 font-medium text-ardoise group-hover:text-encre">
        {productText(tp, product.key, "title")}
      </h3>
      <p className="mt-1 text-sm leading-relaxed text-ardoise/60">
        {productText(tp, product.key, "tagline")}
      </p>
      <p className="mt-3 font-mono-data text-xs text-ardoise/40">
        {tr("phases", { count: phaseCount })} · {tr("tasks", { count: taskCount })}
      </p>
      <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-encre transition-colors group-hover:underline">
        {tr("viewDetail")}
        <ArrowRight className="size-3.5" aria-hidden />
      </span>
    </Link>
  );
}
