# 代码注释规范

新增或修改的声明紧贴写官方文档注释：**TypeScript 用 JSDoc `/** ... */`（遵循 TSDoc 标签），Rust 用 rustdoc `///` / `//!`**。覆盖关键字：`function`（含 `async`）、`interface`、`type`、`enum`、`class`、`struct`、`const`、`let`，带 `export` 或 `pub` 的同样适用；自定义 Hook（`use*`）与未导出的辅助声明不豁免。按形态要求：

- **function / 箭头函数**：一句话契约 + `@param` 逐个 + `@returns`（`void` 也写，说明副作用与提前返回条件）；会 reject 的异步函数写 `@throws`。Rust 函数遵循 rustdoc 小节规范（签名已自文档化，不逐个复述参数返回值）。
- **interface / type 别名 / enum**：一句话契约；每个成员/变体带前置 `/** */`（Rust 用 `///`），仅源码阅读用的用行尾 `//` 简注（不进文档工具）。
- **class / struct**：一句话契约；字段至少行尾 `//` 简注，需要进悬停/文档页的用前置 `/** */`（Rust 用 `///`）。
- **const / let 标量字面量**（string/number/boolean）：一句话契约即可，无标签要求。
- **const 对象 / 数组 / 配置表**：一句话契约，说明结构与取值含义。
- **store / 自定义 Hook（`use*`）返回对象**：`@returns` 逐字段说明解构属性与动作。

自动生成的文件（如 Tauri bindings、codegen 文件）与存量代码不适用本规范（存量不批量补）。

- **结构**：第一段自然语言就是一句话契约（第一个空行前的内容进搜索与模块概览，务必一行）；细节与设计原因放 `@remarks`（TS）或正文后续段落（Rust）。
- **TS 标签**：`@param` / `@returns` 按序逐个说明，`@returns` 写明 `null`/`undefined`/空数组等特殊值；异步失败写 `@throws` 并注明 reject 的类型及判定方式，同步异常同样 `@throws`；泛型约束无需专门标签，参数说明里带出即可；可见性、弃用等用 TSDoc 标签 `@deprecated` / `@experimental`，不造新标签。
- **React 组件**：
  - 组件契约（props、ref、回调）写进对应声明的 JSDoc：组件函数上方注释整体职责，Props 接口每个字段用前置 `/** */` 说明取值、单位与默认值语义。
  - 自定义 Hook（`use*`）按普通函数规范写 JSDoc；返回值是对象或元组时逐项说明。
  - JSX 内只写「为什么」型 `{/* */}` 注释（非直觉的分支、边界时序处理），不复述 DOM 结构；样式文件内不写废话注释，语义放进类名。
- **Rust 小节**：官方约定小节为 `# Examples`（代码块按 doctest 执行，不适合跑的加 `no_run` 或 `ignore`）、`# Errors`（返回 `Result` 的函数逐变体写触发条件，用 `[`Type::Variant`]` intra-doc 链接引用变体，可 `matches!` 判定的写明）、`# Panics`、`# Safety`（unsafe 函数）；**不逐个复述参数与返回值**；调用限制与副作用（并发安全、持锁、`Future` 取消、须 `close`/`drop`、改入参或共享状态、启动任务）写在第一段之后的正文段落；语法优先 `///` 行文档，`//!` 只用于模块/crate 级文档，doc comment 放在 attributes 之前；每个 `# 标题` 与其内容之间空一行；弃用标注用 `#[deprecated(note = "…")]` 属性而非注释。
- **小节排序**（两语言一致）：一句话契约 → 细节正文 → `# Errors`/`# Panics`/`# Safety`/`@throws` → `@remarks` → `# Examples` / `@example`（Rust 官方惯例 Examples 收尾）。
- **引用**：跨项引用用可校验链接——Rust 用 `[`Type`]` intra-doc link（编译期检查），TS 用 `{@link Type}`；不要写「见 xx.rs 第 N 行」这类行号引用（行号会漂移）。
- **内容**：写业务契约与设计原因（单位、状态转换、错误边界、时序参数），不复述代码或签名；无内容的小节不留空；禁止用注释记载变更历史（那是 git 的事），禁止写外部参考项目来源。

Rust 示例：

```rust
/// 获取第三方平台的接口调用凭据。
///
/// 取消时中止刷新且不写缓存。
///
/// 并发安全；同租户并发刷新合并为一次上游请求。
///
/// # Errors
///
/// - [`TokenError::Expired`]：凭据已过期
/// - [`TokenError::Network`]：上游不可达（可 `matches!` 判定）
///
/// # Examples
///
/// ```no_run
/// let token = get_access_token(&ctx, &user)?;
/// ```
fn get_access_token(ctx: &Ctx, user: &Member) -> Result<String, TokenError>

/// 已缓存的第三方平台凭据。
struct Credential {
    /// 访问令牌，不含 Bearer 前缀
    token: String,
    /// 过期时刻，提前 60 秒视为过期
    expires_at: Instant,
}
```

TypeScript 函数与接口示例：

```ts
/**
 * 获取第三方平台的接口调用凭据。
 *
 * @param ctx - 请求上下文；取消时中止刷新且不写缓存
 * @param user - 当前登录用户及租户信息
 * @returns 接口调用凭据，不含 Bearer 前缀
 * @throws {@link TokenExpiredError} 凭据已过期时 reject
 * @throws 凭据服务未初始化时同步抛出
 * @remarks 并发安全；同租户并发刷新合并为一次上游请求
 */
function getAccessToken(ctx: Ctx, user: Member): Promise<string>

/** 已缓存的第三方平台凭据。 */
interface Credential {
  /** 访问令牌，不含 Bearer 前缀 */
  token: string;
  /** 过期时刻（epoch 毫秒），提前 60 秒视为过期 */
  expiresAt: number;
}
```

React 组件与 Hook 示例：

```tsx
/** 提交确认弹窗的入参。 */
interface CommitDialogProps {
  /** 待提交的文件路径列表，为空时禁用确认按钮 */
  files: readonly string[];
  /** 默认选中的提交选项；未指定时默认走普通非追加提交 */
  amend?: boolean;
  /** 确认提交时的回调；接收填写的提交信息 */
  onConfirm: (message: string) => Promise<void>;
  /** 取消或按 Esc 关闭时的回调 */
  onCancel: () => void;
}

/**
 * 提交确认弹窗；负责用户输入提交说明并派发 VCS 提交任务。
 */
export function CommitDialog({ files, amend = false, onConfirm, onCancel }: CommitDialogProps) {
  // ...
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      {/* 点击弹窗内部阻止事件冒泡，避免误触发背景点击关闭 */}
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        {/* ... */}
      </div>
    </div>
  );
}

/**
 * 监听指定文档的保存状态与脏标记。
 *
 * @param path - 文档绝对路径；为空或虚拟文档时始终返回非脏
 * @returns 文档脏状态及保存方法
 */
export function useDocumentDirty(path: string): {
  /** 当前正文与磁盘基线是否不一致 */
  isDirty: boolean;
  /** 触发就地存盘动作 */
  save: () => Promise<void>;
} {
  // ...
}
```
