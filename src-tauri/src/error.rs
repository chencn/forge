//! 后端错误的统一出口：只回「稳定代码 + 原文」，不回给人看的话。
//!
//! 文案由前端按界面语言拼。后端把中文写死，切到英文界面后横幅还是中文，
//! 而且同一条错误在两边没法共用一份措辞。

/// 代码与原文、以及原文各段之间的分隔符。取一个不会出现在真实文本里的控制字符。
pub const SEP: char = '\u{1}';

/// 拼一条带码错误。后面的每个参数都是给人看的原文片段（路径、git 的 stderr 等）。
pub fn err(code: &str, detail: impl std::fmt::Display) -> String {
    let detail = detail.to_string();
    if detail.is_empty() {
        return code.to_string();
    }
    format!("{code}{SEP}{detail}")
}

/// 带多段细节的错误，前端按顺序取。
pub fn err_parts(code: &str, parts: &[String]) -> String {
    if parts.is_empty() {
        return code.to_string();
    }
    format!("{code}{SEP}{}", parts.join(&SEP.to_string()))
}
