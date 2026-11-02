/* Adapted from shadcn/ui base-nova Marker (MIT), used for file checkpoints.
 * https://ui.shadcn.com/r/styles/base-nova/marker.json
 */
import { useRender } from "@base-ui/react/use-render";
import "./ai-elements.css";

export function Marker({ render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({ defaultTagName: "div", render, props, state: { slot: "marker", variant: "default" } });
}
