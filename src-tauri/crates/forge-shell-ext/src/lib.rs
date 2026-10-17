//! 编辑器认得出、并且本体是文本的扩展名。
//!
//! 主程序（写经典右键动词与「打开方式」）和 `forge-shell-cmd`（Win11 新菜单里
//! 决定显示还是隐藏）都要按这份名单判断，两边各抄一份迟早写岔，所以放在这里。
//! 以编辑器语言表为准，再补上纯文本常见后缀。

/// 小写、不含点。
pub const TEXT_EXTENSIONS: &[&str] = &[
    "adoc", "asciidoc", "axaml", "bash", "bat", "bicep", "c", "cc", "cfg", "cjs", "clj", "cljc",
    "cljs", "cmd", "coffee", "conf", "config", "cpp", "cs", "cshtml", "csproj", "css", "csv", "cts",
    "cyp", "cypher", "dart", "dax", "dockerfile", "edn", "env", "ex", "exs", "fs", "fsi", "fsproj",
    "fsscript", "fsx", "ftl", "ftlh", "ftlx", "gemspec", "go", "graphql", "h", "handlebars", "hbs",
    "hcl", "hpp", "htm", "html", "iecst", "ini", "jade", "java", "jl", "js", "json", "json5", "jsonc",
    "jsx", "kt", "kts", "less", "liquid", "log", "lua", "m", "manifest", "markdown", "md", "mdown",
    "mdx", "mjs", "mkd", "msdax", "mts", "org", "p", "pas", "php", "pl", "pm", "pp", "pq", "pqm",
    "properties", "props", "proto", "ps1", "psd1", "psm1", "pug", "py", "r", "rb", "rbx", "rjs",
    "rkt", "rq", "rs", "rst", "sass", "sbt", "sc", "scala", "sch", "scm", "scss", "sh", "sol", "sql",
    "ss", "st", "sv", "svelte", "svg", "svh", "swift", "targets", "tcl", "text", "tf", "tfvars",
    "toml", "ts", "tsp", "tsx", "tsv", "twig", "txt", "vbproj", "vcxproj", "vue", "wgsl", "wxi",
    "wxl", "wxs", "xaml", "xml", "xsd", "xsl", "xslt", "yaml", "yml", "zsh",
];

/// 名单里有没有这一条。`ext` 大小写不敏感，不带前导点。
pub fn is_text_extension(ext: &str) -> bool {
    TEXT_EXTENSIONS
        .iter()
        .any(|item| item.eq_ignore_ascii_case(ext))
}

/// 把用户输入收成一条扩展名：去掉空白和前导点，小写。不合规则返回 `None`。
pub fn canonical_extension(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let stripped = trimmed
        .strip_prefix("*.")
        .or_else(|| trimmed.strip_prefix('.'))
        .unwrap_or(trimmed);
    let text = stripped.trim().to_ascii_lowercase();
    if text.is_empty() || text.len() > 32 {
        return None;
    }
    let mut chars = text.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphanumeric() {
        return None;
    }
    if !chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '+' | '-')) {
        return None;
    }
    Some(text)
}

/// 用户追加的扩展名。内置名单里已有的丢掉，重复的只留第一次。
pub fn normalize_extra_extensions(raw: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for item in raw {
        let Some(ext) = canonical_extension(item) else {
            continue;
        };
        if is_text_extension(&ext) {
            continue;
        }
        if out.iter().any(|held: &String| held.eq_ignore_ascii_case(&ext)) {
            continue;
        }
        out.push(ext);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn text_extensions_are_unique_lowercase_and_reject_binaries() {
        let mut seen = BTreeSet::new();
        for ext in TEXT_EXTENSIONS {
            assert!(seen.insert(*ext), "扩展名重复：{ext}");
            assert_eq!(*ext, ext.to_ascii_lowercase(), "扩展名要小写：{ext}");
            assert!(!ext.starts_with('.'), "扩展名不要带点：{ext}");
        }
        for banned in [
            "png", "jpg", "jpeg", "gif", "webp", "exe", "dll", "zip", "pdf", "docx", "svgz", "mp4",
            "wasm",
        ] {
            assert!(!is_text_extension(banned), "{banned} 不该在白名单里");
        }
        assert!(is_text_extension("TXT"));
        assert!(is_text_extension("rs"));
        assert!(is_text_extension("svg"));
    }

    #[test]
    fn canonical_extension_strips_prefix_and_lowercases() {
        assert_eq!(canonical_extension("*.PRISMA"), Some("prisma".into()));
        assert_eq!(canonical_extension(".Json"), Some("json".into()));
        assert_eq!(canonical_extension("  http  "), Some("http".into()));
        assert_eq!(canonical_extension("bad/ext"), None);
        assert_eq!(canonical_extension(""), None);
        assert_eq!(canonical_extension(&"x".repeat(33)), None);
    }

    #[test]
    fn extra_extensions_drop_builtin_and_duplicates() {
        let extras = normalize_extra_extensions(&[
            "TXT".into(),
            ".prisma".into(),
            "prisma".into(),
            "*.PRISMA".into(),
            "bad/ext".into(),
            "  http  ".into(),
        ]);
        assert_eq!(extras, vec!["prisma".to_string(), "http".to_string()]);
    }
}
