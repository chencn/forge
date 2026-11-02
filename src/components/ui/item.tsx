/* Adapted from shadcn/ui base-nova Item (MIT): slots shared by AI Elements patterns.
 * https://ui.shadcn.com/r/styles/base-nova/item.json
 * Keep render composition for the existing semantic section; omit unused variants.
 */
import type { ComponentProps } from "react";
import { useRender } from "@base-ui/react/use-render";
import "./ai-elements.css";

export function Item({ render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({ defaultTagName: "div", render, props, state: { slot: "item", variant: "outline", size: "sm" } });
}

export function ItemMedia(props: ComponentProps<"div">) {
  return <div data-slot="item-media" data-variant="icon" {...props} />;
}

export function ItemContent(props: ComponentProps<"div">) {
  return <div data-slot="item-content" {...props} />;
}

export function ItemTitle(props: ComponentProps<"div">) {
  return <div data-slot="item-title" {...props} />;
}

export function ItemActions(props: ComponentProps<"div">) {
  return <div data-slot="item-actions" {...props} />;
}
