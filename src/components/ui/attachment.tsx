/* Adapted from shadcn/ui base-nova Attachment (MIT), image group slots only.
 * https://ui.shadcn.com/r/styles/base-nova/attachment.json
 */
import type { ComponentProps } from "react";
import { useRender } from "@base-ui/react/use-render";
import "./ai-elements.css";

/** 单个附件槽（base-ui useRender 透传，状态固定为 done）。 */
export function Attachment({ render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({ defaultTagName: "div", render, props, state: { slot: "attachment", state: "done", orientation: "vertical", size: "sm" } });
}
/** 附件分组容器。 */
export function AttachmentGroup(props: ComponentProps<"div">) {
  return <div data-slot="attachment-group" {...props} />;
}
