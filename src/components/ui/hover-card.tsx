/* Adapted from shadcn/ui base-nova Hover Card (MIT), with Forge theme tokens.
 * https://ui.shadcn.com/r/styles/base-nova/hover-card.json
 */
import { PreviewCard } from "@base-ui/react/preview-card";
import "./ai-elements.css";

/** 悬浮卡片根组件（base-ui PreviewCard 透传）。 */
export function HoverCard(props: PreviewCard.Root.Props) { return <PreviewCard.Root {...props} />; }
/** 悬浮卡片的触发元素。 */
export function HoverCardTrigger(props: PreviewCard.Trigger.Props) { return <PreviewCard.Trigger data-slot="hover-card-trigger" {...props} />; }
/** 悬浮卡片的弹出内容（Portal + 定位偏移 5px）。 */
export function HoverCardContent(props: PreviewCard.Popup.Props) {
  return <PreviewCard.Portal><PreviewCard.Positioner sideOffset={5} align="start" className="ai-element-hover-positioner">
    <PreviewCard.Popup data-slot="hover-card-content" className="ai-element-hover-card" {...props} />
  </PreviewCard.Positioner></PreviewCard.Portal>;
}
