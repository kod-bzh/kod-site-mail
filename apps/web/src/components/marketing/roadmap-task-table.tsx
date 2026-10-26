"use client";

import Link from "next/link";
import { getProductBySlug } from "@/lib/products-catalog";
import { useT } from "@/i18n/t";
import { productText, asStringTranslator } from "@/i18n/product-messages";

const TASK_STATUS_STYLES = {
  done: "bg-verin/10 text-verin",
  in_progress: "bg-encre/10 text-encre",
  planned: "bg-neutral-100 text-ardoise/60",
  blocked: "bg-ambre/10 text-ambre",
} as const;

type RoadmapTaskTableProps = {
  slug: string;
};

export function RoadmapTaskTable({ slug }: RoadmapTaskTableProps) {
  const t = useT("roadmap");
  const tp = asStringTranslator(useT("products"));
  const product = getProductBySlug(slug);
  if (!product) return null;

  const allTasks = product.phases.flatMap((phase) =>
    phase.tasks.map((task) => ({ ...task, phaseId: phase.id }))
  );

  const taskIds = new Set(allTasks.map((t) => t.id));

  return (
    <div className="overflow-x-auto rounded-xl border border-canal bg-paper">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-canal bg-neutral-50/80">
            <th className="px-4 py-3 font-medium text-ardoise/60">{t("gantt.phase")}</th>
            <th className="px-4 py-3 font-medium text-ardoise/60">{t("gantt.task")}</th>
            <th className="px-4 py-3 font-medium text-ardoise/60">{t("gantt.start")}</th>
            <th className="px-4 py-3 font-medium text-ardoise/60">{t("gantt.end")}</th>
            <th className="px-4 py-3 font-medium text-ardoise/60">{t("gantt.dependsOn")}</th>
            <th className="px-4 py-3 font-medium text-ardoise/60">{t("gantt.statusColumn")}</th>
          </tr>
        </thead>
        <tbody>
          {allTasks.map((task) => (
            <tr key={task.id} id={`task-${task.id}`} className="border-b border-canal/50 scroll-mt-24">
              <td className="px-4 py-3 text-xs text-ardoise/50">
                {productText(tp, product.key, `phases.${task.phaseId}.title`)}
              </td>
              <td className="px-4 py-3 font-medium text-ardoise">
                {productText(tp, product.key, `tasks.${task.id}`)}
              </td>
              <td className="px-4 py-3 font-mono-data text-xs text-ardoise/60">{task.startMonth}</td>
              <td className="px-4 py-3 font-mono-data text-xs text-ardoise/60">{task.endMonth}</td>
              <td className="px-4 py-3 text-xs">
                {task.dependsOn && task.dependsOn.length > 0 ? (
                  <ul className="space-y-1">
                    {task.dependsOn.map((depId) =>
                      taskIds.has(depId) ? (
                        <li key={depId}>
                          <Link
                            href={`#task-${depId}`}
                            className="text-encre hover:underline"
                          >
                            {productText(tp, product.key, `tasks.${depId}`)}
                          </Link>
                        </li>
                      ) : null
                    )}
                  </ul>
                ) : (
                  <span className="text-ardoise/40">{t("gantt.noDeps")}</span>
                )}
              </td>
              <td className="px-4 py-3">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${TASK_STATUS_STYLES[task.status]}`}
                >
                  {t(`taskStatus.${task.status}`)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
