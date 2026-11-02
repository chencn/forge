/* Adapted from shadcn/ui base-nova Attachment (MIT), image group slots only.
 * https://ui.shadcn.com/r/styles/base-nova/attachment.json
 */
import type { ComponentProps } from "react";
import { useRender } from "@base-ui/react/use-render";
import "./ai-elements.css";

export function Attachment({ render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({ defaultTagName: "div", render, props, state: { slot: "attachment", state: "done", orientation: "vertical", size: "sm" } });
}
export function AttachmentGroup(props: ComponentProps<"div">) {
  return <div data-slot="attachment-group" {...props} />;
}
