/* Adapted from shadcn/ui base-nova Trace (MIT).
 * https://ui.shadcn.com/r/styles/base-nova/trace.json
 * Utility classes map to Forge tokens in ai-elements.css; only used slots are included.
 */
import type { ComponentProps } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight } from "lucide-react";
import "./ai-elements.css";

/** 工具调用追踪容器。 */
export function Trace(props: ComponentProps<"div">) {
  return <div data-slot="trace" {...props} />;
}

/** 追踪一行；status 驱动运行中/错误/待定配色。 */
export function TraceLine({ status, ...props }: ComponentProps<"span"> & { status?: "running" | "error" | "pending" }) {
  return <span data-slot="trace-line" data-status={status} {...props} />;
}

/** 行首图标槽。 */
export function TraceIcon(props: ComponentProps<"span">) {
  return <span data-slot="trace-icon" aria-hidden="true" {...props} />;
}

/** 行标题文字。 */
export function TraceTitle(props: ComponentProps<"span">) {
  return <span data-slot="trace-title" {...props} />;
}

/** 行副文字。 */
export function TraceDescription(props: ComponentProps<"span">) {
  return <span data-slot="trace-description" {...props} />;
}

/** 可折叠区块；受控时必须同时给 open 与 onOpenChange。 */
export function TraceCollapsible(props: Omit<Collapsible.Root.Props, "open"> & (
  { open?: undefined } | { open: boolean; onOpenChange: NonNullable<Collapsible.Root.Props["onOpenChange"]> }
)) {
  return <Collapsible.Root data-slot="trace-collapsible" {...props} />;
}

/** 折叠开关行（自带右侧箭头）。 */
export function TraceCollapsibleTrigger({ children, ...props }: Collapsible.Trigger.Props) {
  return <Collapsible.Trigger data-slot="trace-collapsible-trigger" {...props}>
    {children}
    <TraceIcon><ChevronRight size={14} /></TraceIcon>
  </Collapsible.Trigger>;
}

/** 折叠内容（带内边距容器）。 */
export function TraceCollapsibleContent({ className, children, ...props }: Omit<Collapsible.Panel.Props, "className"> & { className?: string }) {
  return <Collapsible.Panel data-slot="trace-collapsible-content" {...props}>
    <div data-slot="trace-collapsible-content-inner" className={className}>{children}</div>
  </Collapsible.Panel>;
}
