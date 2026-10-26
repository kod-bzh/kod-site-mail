"use client";

import { useMemo, useState } from "react";
import {
  generateMonthLabels,
  getProductBySlug,
  getTimelineBounds,
  monthToIndex,
  type RoadmapTask,
} from "@/lib/products-catalog";
import { useT } from "@/i18n/t";
import { productText, asStringTranslator } from "@/i18n/product-messages";

const TASK_STATUS_COLORS = {
  done: "bg-verin",
  in_progress: "bg-encre",
  planned: "bg-ardoise/25",
  blocked: "bg-ambre",
} as const;

const ROW_HEIGHT = 36;
const LABEL_WIDTH = 200;
const MONTH_WIDTH = 48;

type FlatTask = RoadmapTask & {
  phaseId: string;
  phaseOrder: number;
  rowIndex: number;
  label: string;
};

type RoadmapGanttProps = {
  slug: string;
};

function formatMonthLabel(month: string): string {
  const [year, m] = month.split("-");
  const months = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
  return `${months[Number(m) - 1]} ${year.slice(2)}`;
}

export function RoadmapGantt({ slug }: RoadmapGanttProps) {
  const t = useT("roadmap");
  const tp = asStringTranslator(useT("products"));
  const [hoveredTask, setHoveredTask] = useState<string | null>(null);
  const product = getProductBySlug(slug);

  const bounds = getTimelineBounds();
  const boundsStart = bounds.start;
  const monthLabels = generateMonthLabels(bounds.start, bounds.end);
  const totalMonths = monthLabels.length;

  const flatTasks: (FlatTask & { showPhaseHeader: boolean })[] = useMemo(() => {
    if (!product) return [];
    const result: (FlatTask & { showPhaseHeader: boolean })[] = [];
    let rowIndex = 0;
    let lastPhaseId = "";
    for (const phase of product.phases) {
      for (const task of phase.tasks) {
        const showPhaseHeader = phase.id !== lastPhaseId;
        lastPhaseId = phase.id;
        result.push({
          ...task,
          phaseId: phase.id,
          phaseOrder: phase.order,
          rowIndex,
          label: productText(tp, product.key, `tasks.${task.id}`),
          showPhaseHeader,
        });
        rowIndex++;
      }
    }
    return result;
  }, [product, tp]);

  const gridWidth = totalMonths * MONTH_WIDTH;
  const gridHeight = flatTasks.length * ROW_HEIGHT;

  const taskById = useMemo(
    () => new Map(flatTasks.map((task) => [task.id, task])),
    [flatTasks]
  );

  if (!product) return null;

  const dependencyPaths: { from: string; to: string; d: string }[] = [];
  for (const task of flatTasks) {
    if (!task.dependsOn) continue;
    for (const depId of task.dependsOn) {
      const dep = taskById.get(depId);
      if (!dep) continue;

      const depEndCol = monthToIndex(dep.endMonth, boundsStart) + 1;
      const taskStartCol = monthToIndex(task.startMonth, boundsStart);

      const x1 = LABEL_WIDTH + depEndCol * MONTH_WIDTH;
      const y1 = dep.rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
      const x2 = LABEL_WIDTH + taskStartCol * MONTH_WIDTH;
      const y2 = task.rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;

      const midX = (x1 + x2) / 2;
      const d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
      dependencyPaths.push({ from: depId, to: task.id, d });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 text-xs">
        <span className="font-medium text-ardoise">{t("gantt.legend")} :</span>
        {(["done", "in_progress", "planned", "blocked"] as const).map((status) => (
          <span key={status} className="inline-flex items-center gap-1.5">
            <span className={`size-3 rounded-sm ${TASK_STATUS_COLORS[status]}`} />
            {t(`taskStatus.${status}`)}
          </span>
        ))}
      </div>

      <p className="text-xs text-ardoise/50 sm:hidden">{t("gantt.scrollHint")}</p>

      <div className="overflow-x-auto rounded-xl border border-canal bg-paper">
        <div style={{ minWidth: LABEL_WIDTH + gridWidth + 16 }}>
          <div className="flex border-b border-canal bg-neutral-50/80">
            <div
              className="shrink-0 border-r border-canal px-3 py-2 text-xs font-medium text-ardoise/60"
              style={{ width: LABEL_WIDTH }}
            >
              {t("gantt.task")}
            </div>
            <div className="flex" style={{ width: gridWidth }}>
              {monthLabels.map((month, i) => (
                <div
                  key={month}
                  className="shrink-0 border-r border-canal/50 px-1 py-2 text-center text-[10px] font-mono-data text-ardoise/40"
                  style={{ width: MONTH_WIDTH }}
                >
                  {i % 3 === 0 ? formatMonthLabel(month) : ""}
                </div>
              ))}
            </div>
          </div>

          <div className="relative">
            <svg
              className="pointer-events-none absolute inset-0 z-10"
              style={{
                width: LABEL_WIDTH + gridWidth,
                height: gridHeight,
                left: 0,
                top: 0,
              }}
            >
              {dependencyPaths.map(({ from, to, d }) => (
                <path
                  key={`${from}-${to}`}
                  d={d}
                  fill="none"
                  stroke="#1612d3"
                  strokeWidth="1.5"
                  strokeOpacity="0.35"
                  markerEnd="url(#arrowhead)"
                />
              ))}
              <defs>
                <marker
                  id="arrowhead"
                  markerWidth="6"
                  markerHeight="6"
                  refX="5"
                  refY="3"
                  orient="auto"
                >
                  <polygon points="0 0, 6 3, 0 6" fill="#1612d3" fillOpacity="0.5" />
                </marker>
              </defs>
            </svg>

            {flatTasks.map((task) => {
              const startCol = monthToIndex(task.startMonth, boundsStart);
              const endCol = monthToIndex(task.endMonth, boundsStart);
              const span = endCol - startCol + 1;

              return (
                <div key={task.id}>
                  {task.showPhaseHeader && (
                    <div
                      className="flex border-b border-canal bg-encre-muted/40"
                      style={{ height: 28 }}
                    >
                      <div
                        className="flex items-center px-3 text-xs font-medium text-encre"
                        style={{ width: LABEL_WIDTH + gridWidth }}
                      >
                        {productText(tp, product.key, `phases.${task.phaseId}.title`)}
                      </div>
                    </div>
                  )}
                  <div
                    className="flex border-b border-canal/50 hover:bg-neutral-50/50"
                    style={{ height: ROW_HEIGHT }}
                    onMouseEnter={() => setHoveredTask(task.id)}
                    onMouseLeave={() => setHoveredTask(null)}
                    onFocus={() => setHoveredTask(task.id)}
                    onBlur={() => setHoveredTask(null)}
                  >
                    <div
                      className="flex shrink-0 items-center truncate border-r border-canal/50 px-3 text-xs text-ardoise"
                      style={{ width: LABEL_WIDTH }}
                      title={task.label}
                    >
                      <span id={`task-${task.id}`} className="truncate">
                        {task.label}
                      </span>
                    </div>
                    <div className="relative" style={{ width: gridWidth, height: ROW_HEIGHT }}>
                      <div
                        className={`absolute top-2 h-5 rounded-sm ${TASK_STATUS_COLORS[task.status]} transition-opacity ${
                          hoveredTask === task.id ? "opacity-100 ring-2 ring-encre/30" : "opacity-90"
                        }`}
                        style={{
                          left: startCol * MONTH_WIDTH + 2,
                          width: Math.max(span * MONTH_WIDTH - 4, 8),
                        }}
                        role="img"
                        aria-label={`${task.label}: ${task.startMonth} → ${task.endMonth}`}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
