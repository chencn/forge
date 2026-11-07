/* Adapted from shadcn/ui base-nova Item (MIT): slots shared by AI Elements patterns.
 * https://ui.shadcn.com/r/styles/base-nova/item.json
 * Keep render composition for the existing semantic section; omit unused variants.
 */
import type { ComponentProps } from "react";
import { useRender } from "@base-ui/react/use-render";
import "./ai-elements.css";

/** 列表项容器（带 outline 样式），`render` 可换渲染标签。 */
export function Item({ render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({ defaultTagName: "div", render, props, state: { slot: "item", variant: "outline", size: "sm" } });
}

/** 列表项左侧的图标/媒体区。 */
export function ItemMedia(props: ComponentProps<"div">) {
  return <div data-slot="item-media" data-variant="icon" {...props} />;
}

/** 列表项的正文区（标题 + 描述）。 */
export function ItemContent(props: ComponentProps<"div">) {
  return <div data-slot="item-content" {...props} />;
}

/** 列表项的标题行。 */
export function ItemTitle(props: ComponentProps<"div">) {
  return <div data-slot="item-title" {...props} />;
}

/** 列表项尾部的动作按钮区。 */
export function ItemActions(props: ComponentProps<"div">) {
  return <div data-slot="item-actions" {...props} />;
}
