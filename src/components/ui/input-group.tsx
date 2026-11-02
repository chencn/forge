/* Adapted from shadcn/ui base-nova Input Group (MIT); only the multiline composer slots.
 * https://ui.shadcn.com/r/styles/base-nova/input-group.json
 * Native controls preserve IME and the caller's real input/send contracts.
 */
import type { ComponentProps } from "react";
import "./ai-elements.css";

export function InputGroup(props: ComponentProps<"div">) {
  return <div data-slot="input-group" role="group" {...props} />;
}
export function InputGroupAddon({ align, ...props }: ComponentProps<"div"> & { align: "block-start" | "block-end" }) {
  return <div data-slot="input-group-addon" data-align={align} {...props} />;
}
