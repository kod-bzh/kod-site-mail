"use client";

import { useMemo, useState } from "react";
import {
  PRODUCT_CATEGORIES,
  PRODUCT_DEFINITIONS,
  PRODUCT_STATUSES,
  type ProductCategory,
  type ProductStatus,
} from "@/lib/products-catalog";
import { useT } from "@/i18n/t";
import { ProductCard } from "./product-card";

export function FilteredProductGrid() {
  const t = useT("roadmap");
  const tp = useT("products");
  const [category, setCategory] = useState<ProductCategory | "all">("all");
  const [status, setStatus] = useState<ProductStatus | "all">("all");

  const filtered = useMemo(() => {
    return PRODUCT_DEFINITIONS.filter((p) => {
      if (category !== "all" && p.category !== category) return false;
      if (status !== "all" && p.status !== status) return false;
      return true;
    });
  }, [category, status]);

  return (
    <>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-ardoise/60">{t("filterCategory")}</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ProductCategory | "all")}
            className="rounded-md border border-canal bg-paper px-3 py-1.5 text-sm text-ardoise"
          >
            <option value="all">{t("filterAll")}</option>
            {PRODUCT_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {tp(`categories.${cat}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-ardoise/60">{t("filterStatus")}</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as ProductStatus | "all")}
            className="rounded-md border border-canal bg-paper px-3 py-1.5 text-sm text-ardoise"
          >
            <option value="all">{t("filterAll")}</option>
            {PRODUCT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((product) => (
          <li key={product.key}>
            <ProductCard slug={product.slug} />
          </li>
        ))}
      </ul>
    </>
  );
}
