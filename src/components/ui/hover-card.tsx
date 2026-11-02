/* Adapted from shadcn/ui base-nova Hover Card (MIT), with Forge theme tokens.
 * https://ui.shadcn.com/r/styles/base-nova/hover-card.json
 */
import { PreviewCard } from "@base-ui/react/preview-card";
import "./ai-elements.css";

export function HoverCard(props: PreviewCard.Root.Props) { return <PreviewCard.Root {...props} />; }
export function HoverCardTrigger(props: PreviewCard.Trigger.Props) { return <PreviewCard.Trigger data-slot="hover-card-trigger" {...props} />; }
export function HoverCardContent(props: PreviewCard.Popup.Props) {
  return <PreviewCard.Portal><PreviewCard.Positioner sideOffset={5} align="start" className="ai-element-hover-positioner">
    <PreviewCard.Popup data-slot="hover-card-content" className="ai-element-hover-card" {...props} />
  </PreviewCard.Positioner></PreviewCard.Portal>;
}
