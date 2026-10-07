# Agent Note: Web 应用主屏幕图标集

Status: implemented

[English](2026-08-19-web-app-icon-set.md) | 中文

## 问题

Web 应用原先唯一的图标是浅色与深色标签页 favicon `favicon.svg`／`favicon-dark.svg`：一个由 `prefers-color-scheme` 媒体链接选择的透明单色鲸鱼。把应用添加到 iPhone 主屏幕会得到一个很差的图标：iOS Safari 不会为主屏幕栅格化 SVG favicon，而是从光栅 `apple-touch-icon` 取图；缺少它时会改用一张生成的图像。安装 manifest 在其他平台上有同样的缺口：它原先唯一的图标是透明的黑色鲸鱼，在启动器自身的背景上读作一个黑色字形，也没有提供 maskable 变体。

## 决策

Web 应用在保持不变的标签页 favicon 旁交付一套光栅主屏幕图标。标签页 favicon 与主屏幕图标是两个独立角色：标签页保留按媒体查询选择的浅色／深色鲸鱼，所有已安装或主屏幕表层都使用同一个不透明方砖标志。

- **该标志**是一块品牌蓝（`#3964FE`）方砖，其上是围绕一个白色中心节点的两个白色方括号。它的几何结构从 180px 主屏幕图标到较小的启动器尺寸都保持清晰，且方砖自带背景，因此不需要配色方案变体。
- **`apple-touch-icon.png`**（180×180，不透明满幅方形；iOS 自行应用圆角遮罩）为 iOS Safari 提供清晰的主屏幕图像。`index.html` 以 `<link rel="apple-touch-icon">` 链接它，并把 `apple-mobile-web-app-title` 设为与 manifest `short_name` 一致的 `DSH`，使主屏幕标签不依赖构建期的文档标题。
- **`icon-192.png`／`icon-512.png`**（透明背景上的圆角方砖，`purpose: any`）与 **`icon-maskable-512.png`**（不透明满幅，`purpose: maskable`，字形位于 40% 半径安全区内）构成 manifest 的完整图标列表。manifest 不列出 `favicon.svg`，因此浏览器不会为已安装图标选中透明鲸鱼而非方砖。
- 每个引用都遵循[文档相对路由决策](../architecture/2026-09-14-web-document-relative-app-routes.zh.md)：manifest 的 `src` 值是相对 manifest URL 解析的裸文件名，`index.html` 源码路径写成根绝对形式只是因为 Vite 在 `base: './'` 下会把它们改写为 `./`。因此这些图标在任意代理挂载点下都能解析。

`apps/web/scripts/generate-icons.mjs` 是该标志的唯一来源。它通过已声明为 `apps/web` devDependency 的 Playwright Chromium 渲染方砖 SVG，只写出四个 PNG，从不触碰标签页 favicon。应编辑该脚本并在 `apps/web` 下重新运行，而不是手工编辑 PNG。

这些 PNG 位于 `apps/web/public/`，Vite 会把它复制到 `dist/`；`@deepseek-ai/dsh-web-frontend` 包通过其 `files` 列表交付 `dist`，因此 `dsh web` 静态服务器从已安装的包中提供它们。`@deepseek-ai/dsh-host-frontend-static` 把 `.png` 映射为 `image/png`；缺少该表项时这些图标会以 `application/octet-stream` 交付。静态服务器下的非 index 资产保持公开，因此 iOS 无需浏览器认证 cookie 即可获取图标。

不添加静态的 `theme-color` meta、`theme_color` 或 `background_color`：`dsh-client-ui-layout` 的主题呈现器在运行时根据解析出的浅色或深色调色板写入 `meta[name="theme-color"]`，固定值会与其中之一不符。不添加 `apple-mobile-web-app-capable` meta：iOS 从链接的 manifest 的 `display` 成员读取主屏幕启动时的呈现方式，该旧式 meta 只会与之重复。

## 曾考虑的替代方案

- **为主屏幕复用鲸鱼 favicon。** 不予采纳：iOS 需要光栅 `apple-touch-icon`，透明单色字形栅格化到平台背景上会丢失标志；鲸鱼的细节在启动器尺寸下也会劣化。
- **用方砖替换标签页 favicon。** 不予采纳：按媒体查询选择的浅色／深色鲸鱼是标签页身份，只有在平台渲染不透明图标的地方才需要方砖。保持角色分离可让标签页 favicon 保持不变。
- **把 `favicon.svg` 保留为额外的 `any` manifest 图标。** 不予采纳：浏览器可能为已安装图标选用尺寸为 `any` 的 SVG，这会让透明鲸鱼取代方砖出现，并使已安装表层带有两个不同标志。
- **为 PNG 添加 `<link rel="icon" type="image/png">` 行。** 不予采纳：不带媒体限定的 PNG 图标行会在浏览器标签页中与带媒体限定的 SVG favicon 竞争。
- **通过部署品牌槽（`dsh-client-ui-brand-official`）承载这些图标。** 不予采纳：这些槽在外壳启动后占据 React UI（侧边栏品牌），而浏览器与 iOS 在任何插件运行之前就从静态文档中读取图标链接与 manifest。标签页 favicon 与 manifest 同样是静态构建资产，因此主屏幕图标与它们保持一致；品牌不同的部署替换 `apps/web/public/` 中的文件。
- **只提交 PNG，不带生成器。** 不予采纳：该标志必须能从单一来源编辑并复现。

## 后果

- 把 Web 应用添加到 iPhone 主屏幕或作为 PWA 安装，会得到标注为 `DSH` 的清晰方砖图标；浏览器标签页保留浅色／深色鲸鱼 favicon。
- 标签页与已安装表层按设计带有不同标志；未来若统一为单一标志，需要同时修改 favicon 与生成器。
- 品牌不按部署区分：与 favicon 和 manifest 一样，图标集固定在构建出的 `dist/` 中，与 `DSH_CLIENT_BUILD_PROFILE` 和 `DSH_CLIENT_TITLE` 无关。
- `.png` MIME 表项只在提供服务的 `dsh web` 进程重启后生效，因为运行中的服务器持有已加载的模块。
- iOS 在创建主屏幕书签时缓存其图标；已有书签会保留旧图像，直到删除后重新添加。

## 测试

`apps/web/tests/pwa-manifest.e2e.ts` 读取构建出的 `dist/`，固定完整的 manifest 对象（包括三个图标条目）、输出的 `index.html` 中的 `apple-touch-icon` 链接与 `apple-mobile-web-app-title` meta，以及每个 PNG 的签名、尺寸和不透明 RGB 与透明 RGBA 的颜色类型。它在构建后于无需密钥的 `vitest.web.config.ts` 通道中运行。`dsh-host-frontend-static` 的真实 Loader 组合测试提供一个 `.png` 夹具，并固定其 `image/png` 媒体类型。
