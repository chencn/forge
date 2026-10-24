import type { ReactNode } from "react";

/**
 * 会话输入框的外壳，对照参考实现的 composer 盒：单层圆角卡片（rounded-xl、
 * 深一档的边框、聚焦时 3px 内描边），内部自上而下三段——附件缩略图条、
 * 可增长的编辑区、底部动作行（左侧「+ / 设置芯片」，右侧发送）。
 *
 * 会话页与欢迎页共用这一个外壳；欢迎页传 `tall` 抬高编辑区的起步高度。
 * 斜杠命令菜单、拖放浮层等绝对定位内容经 `overlay` 挂进盒内。
 */
export default function AiComposerShell({ editor, attachments, toolbarLeft, toolbarRight, overlay, tall, footer }: {
  /** 编辑区内容（textarea 等）；外壳负责内边距与滚动。 */
  editor: ReactNode;
  /** 附件缩略图条；没有附件时传 null，整行消失。 */
  attachments?: ReactNode;
  /** 底部动作行左侧（「+」菜单、设置芯片）。 */
  toolbarLeft: ReactNode;
  /** 底部动作行右侧（发送/停止按钮）。 */
  toolbarRight: ReactNode;
  /** 挂在盒内的绝对定位层（命令菜单、拖放提示）。 */
  overlay?: ReactNode;
  /** 欢迎页的起步高度更高一档。 */
  tall?: boolean;
  /** 编辑区与动作行之间的补充行（如命令提示）。 */
  footer?: ReactNode;
}) {
  return <div className={`ai-composer${tall ? " is-tall" : ""}${attachments ? " has-attachments" : ""}`}>
    {overlay}
    {attachments ? <div className="ai-composer-attachments">{attachments}</div> : null}
    <div className="ai-composer-editor">{editor}</div>
    {footer}
    <div className="ai-composer-bar">
      <div className="ai-composer-bar-left">{toolbarLeft}</div>
      <div className="ai-composer-bar-right">{toolbarRight}</div>
    </div>
  </div>;
}
