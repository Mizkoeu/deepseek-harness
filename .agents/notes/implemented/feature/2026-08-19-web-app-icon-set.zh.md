# Agent Note: Web 应用图标集 —— 方括号 agent 标志与 iOS 清晰 PNG

Status: implemented

[English](2026-08-19-web-app-icon-set.md) | 中文

## 问题

Web 应用只交付了单个 `favicon.svg`——DeepSeek 鲸鱼标志——作为唯一图标，由 `index.html` 和 PWA manifest 引用。在 iOS Safari 上，把应用添加为主屏书签会得到一个模糊的低分辨率图标：iOS 不会为主屏栅格化 SVG favicon，需要一个光栅 `apple-touch-icon`；当不存在时，它就缩放一个小的回退图标。鲸鱼标志还带有在 16–32px 标签页尺寸下会劣化的细节，也没有传达产品是什么。

## 决策

应用交付一个渲染为完整图标集的小型几何标志：

- **该标志**是一块圆角品牌蓝（`#3964fe`，`--dsw-alias-brand-primary`）方砖，其上是围绕一个白色中心节点的两个白色方括号。方括号读作*包裹并控制*的 harness；节点读作被运行的 *agent*。这一几何结构从 16px 标签页到 180px 主屏图标都保持清晰可辨。方砖自带不透明背景，因此图标不再依赖 `prefers-color-scheme` 的填充切换来在深色标签栏中生存（取代此前已归档的深色模式 favicon 修复）。
- **`apps/web/public/favicon.svg`** 是分辨率无关的主图标（圆角方砖）。
- **`apple-touch-icon.png`**（180×180，满幅方形——iOS 自行应用其圆角遮罩）为 iOS Safari 提供清晰的主屏光栅。`index.html` 链接它，并把 `apple-mobile-web-app-title` 设为 `DSH` 作为主屏标签。
- **`icon-192.png` / `icon-512.png`**（圆角，`purpose: any`）与 **`icon-maskable-512.png`**（满幅，`purpose: maskable`）在 `manifest.webmanifest` 中声明。manifest 依照[安装 manifest 决策](2026-08-06-web-install-manifest.md)刻意持续省略 `theme_color` 和 `background_color`：静态颜色会与运行时解析的浅色/深色调色板之一不符。

这些 PNG 由 `apps/web/scripts/generate-icons.mjs` 从同一几何结构重新生成，它通过已作为 `apps/web` devDependency 内置的 Playwright Chromium 栅格化该 SVG——没有新的图像工具链。标志的真实来源是该脚本；编辑它并重跑，不要手工编辑 PNG。

`@deepseek-ai/dsh-host-frontend-static` 曾把 `.png` 当作 `application/octet-stream` 提供，因为其初始 MIME 表遗漏了该扩展名。既然现在交付 PNG 图标，该表就把 `.png` 映射为 `image/png`；该包的真实组合测试断言这一点，README 也把 PNG 列入所覆盖的资产集合。

## 曾考虑的替代方案

- **缩放现有的鲸鱼标志。** 不予采纳：其细节在小尺寸下无法生存，而仅有 SVG 的 favicon 仍让 iOS 缺少光栅主屏图标。
- **仅用 SVG，不要 PNG。** 不予采纳：iOS Safari 不为主屏使用 SVG，而主屏正是用户报告为模糊的那个表层。
- **只提交 PNG，不带生成器。** 不予采纳：该标志必须保持可编辑、可复现；提交生成器可让光栅集合从单一来源可推导。
- **保留透明单色字形加深色模式填充切换。** 不予采纳：自带背景的彩色方砖更简单，且在浅色和深色标签栏以及作为遮罩主屏图标时读起来都一致。

## 后果

- iOS 主屏与 PWA 安装获得清晰、贴合品牌的图标；浏览器标签页获得一个能在小尺寸下生存并陈述产品身份的标志。
- `.png` MIME 的新增是一行表项，由现有真实组合测试覆盖；它只在提供服务的 `dsh web` 进程重启后生效，因为运行中的服务器持有此前已加载的模块。
- 图标集是五个光栅文件加一个 SVG，全部可由 `generate-icons.mjs` 重新生成；把该脚本视为来源可避免漂移。

## 相关

- 取代已归档的深色模式 favicon 修复（`archived/bug-fix/2026-08-10-web-favicon-dark-mode.md`）：新的自带背景方砖移除了对 `prefers-color-scheme` 填充切换的需要。
