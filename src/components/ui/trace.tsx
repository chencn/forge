/* Adapted from shadcn/ui base-nova Trace (MIT).
 * https://ui.shadcn.com/r/styles/base-nova/trace.json
 * Utility classes map to Forge tokens in ai-elements.css; only used slots are included.
 */
import type { ComponentProps } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight } from "lucide-react";
import "./ai-elements.css";

export function Trace(props: ComponentProps<"div">) {
  return <div data-slot="trace" {...props} />;
}

export function TraceLine({ status, ...props }: ComponentProps<"span"> & { status?: "running" | "error" | "pending" }) {
  return <span data-slot="trace-line" data-status={status} {...props} />;
}

export function TraceIcon(props: ComponentProps<"span">) {
  return <span data-slot="trace-icon" aria-hidden="true" {...props} />;
}

export function TraceTitle(props: ComponentProps<"span">) {
  return <span data-slot="trace-title" {...props} />;
}

export function TraceDescription(props: ComponentProps<"span">) {
  return <span data-slot="trace-description" {...props} />;
}

export function TraceCollapsible(props: Omit<Collapsible.Root.Props, "open"> & (
  { open?: undefined } | { open: boolean; onOpenChange: NonNullable<Collapsible.Root.Props["onOpenChange"]> }
)) {
  return <Collapsible.Root data-slot="trace-collapsible" {...props} />;
}

export function TraceCollapsibleTrigger({ children, ...props }: Collapsible.Trigger.Props) {
  return <Collapsible.Trigger data-slot="trace-collapsible-trigger" {...props}>
    {children}
    <TraceIcon><ChevronRight size={14} /></TraceIcon>
  </Collapsible.Trigger>;
}

export function TraceCollapsibleContent({ className, children, ...props }: Omit<Collapsible.Panel.Props, "className"> & { className?: string }) {
  return <Collapsible.Panel data-slot="trace-collapsible-content" {...props}>
    <div data-slot="trace-collapsible-content-inner" className={className}>{children}</div>
  </Collapsible.Panel>;
}
