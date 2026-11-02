/**
 * 词典按语言懒加载了（见 src/i18n/index.tsx），而测试既不经过 main.tsx 的启动预载，
 * 又有 `renderToStaticMarkup` 这种不跑 effect 的同步渲染路径。
 *
 * 这里在跑任何测试之前把三份词典都装上，测试里的 `translate()` / `t()` 行为与
 * 改动前的静态 import 完全一致——按需加载是运行时（打包体积）的事，测试不必跟着省。
 */
import { ensureLang } from "../src/i18n";

await Promise.all([ensureLang("zh"), ensureLang("en"), ensureLang("zh-TW")]);
