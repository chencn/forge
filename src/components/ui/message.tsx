/* Adapted from shadcn/ui base-nova Message (MIT), only the used slots.
 * https://ui.shadcn.com/r/styles/base-nova/message.json
 * render keeps Forge's semantic articles and stable pagination anchors.
 */
import type { ComponentProps } from "react";
import { useRender } from "@base-ui/react/use-render";
import "./ai-elements.css";

/** 一组消息的容器（分页锚点的宿主）。 */
export function MessageGroup(props: ComponentProps<"div">) {
  return <div data-slot="message-group" {...props} />;
}

/** 单条消息；align 决定左右对齐。 */
export function Message({ render, align = "start", ...props }: useRender.ComponentProps<"div"> & { align?: "start" | "end" }) {
  return useRender({ defaultTagName: "div", render, props, state: { slot: "message", align } });
}
