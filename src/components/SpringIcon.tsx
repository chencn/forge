import { Leaf } from "lucide-react";

/**
 * Spring 那片叶子，和启动配置里的是同一枚描边图标。
 * 颜色交给调用方的 class，不在这里填实心。
 */
export default function SpringIcon({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return <Leaf size={size} className={className} aria-hidden="true" />;
}
