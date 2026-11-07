/* Adapted from shadcn/ui base-nova Input Group (MIT); only the multiline composer slots.
 * https://ui.shadcn.com/r/styles/base-nova/input-group.json
 * Native controls preserve IME and the caller's real input/send contracts.
 */
import type { ComponentProps } from "react";
import "./ai-elements.css";

/** 多行输入组的容器。 */
export function InputGroup(props: ComponentProps<"div">) {
  return <div data-slot="input-group" role="group" {...props} />;
}
/** 输入组上/下沿的附加区（工具条、计数等）。 */
export function InputGroupAddon({ align, ...props }: ComponentProps<"div"> & { align: "block-start" | "block-end" }) {
  return <div data-slot="input-group-addon" data-align={align} {...props} />;
}
