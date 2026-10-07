# Agent Note: 手机宽度下 Web 控件保持可达

Status: implemented

[English](2026-08-15-phone-width-web-controls-remain-reachable.md) | 中文

## 问题

Web 外壳把所有窄框架都当作缩小的桌面。在 390×844 的手机上，收起的侧边栏在网格中保留 56px 控制栏，展开时又恢复 280px 的网格列，对话只剩约 110px。问题卡片的提交按钮和 plan-review 卡片的批准按钮超出卡片右边缘；设置面板在选项栏旁保留 188px 的导航列，选项栏窄到放不下各行内容。输入框草稿使用 14px 文字，因此 iOS Safari 每次聚焦时都会放大页面；页面也没有考虑刘海、状态栏和主屏幕指示条。

## 决定

[AppFrame](../../../../packages/client/ui-layout/src/client/AppFrame.tsx) 在浏览器文档中宽度低于 560px（`SIDEBAR_OVERLAY_BREAKPOINT`）时使用手机布局；最小宽度为 520px 的 macOS 与 Windows 桌面窗口保留各自的窗口 chrome 布局。侧边栏在两种状态下都不占网格列，各列使用显式网格线。收起时，该列像 macOS 桌面收起那样宽度为零，并额外设为 `visibility: hidden`，使其控制栏控件退出焦点顺序与无障碍树；框架挂载已有的 `shell.leading` 座，由 ui-sidebar 的 `HeaderLeadingControls` 提供打开侧边栏与 New Session；框架发布 `--dsh-frame-leading-clearance`，使对话标题避开这两个控件。展开时，同一个已挂载的列以绝对定位覆盖在全宽对话之上，宽度为偏好的侧边栏宽度，并限制为至少留出 56px 不遮挡。其余区域上的遮罩负责关闭它；主视图会话或主面板发生变化时，也会通过幂等的 `dismissSidebarOverlay` store 操作关闭它。浮层没有拖拽手柄。粗指针设备上座内控件为 36px。

决策卡片在同一宽度下换行。审批按钮共享按钮行并可换行。问题卡片页脚把翻页器与反馈保留在第一行，「跳过」与提交占据完整的第二行。plan-review 的决策行位于反馈行下方、横跨整张卡片并可换行。在浏览器文档中，设置面板在安全区域内铺满屏幕，把导航改为标题下方可横向滚动的一行，并把功能操作与 36px 关闭控件放在标题行末端。

粗指针设备上，输入框草稿与问题回答输入框至少使用 16px 文字，从而阻止 iOS 聚焦放大；问题输入框保持 24px 行高，因此六行上限不变。`apps/web` 的 viewport 声明 `viewport-fit=cover` 与 `interactive-widget=resizes-content`，`#root` 以 `env(safe-area-inset-*)` 设置内边距。

## 考虑过的替代方案

**44px 浮动侧边栏开关。** 否决：macOS 收起已经定义了零宽列加 `shell.leading` 重新打开座及其避让约定。复用这条路径可以避免第二种紧凑侧边栏呈现，并让导航关闭时 New Session 仍然可达。

**保留控制栏，只让展开的侧边栏浮层化。** 否决：56px 控制栏仍要占去 390px 对话宽度的七分之一。

**用 `maximum-scale=1` 禁用缩放。** 否决：Android Chrome 会因此同时阻止用户双指缩放；把聚焦的输入框提高到 16px 可以避免 iOS 放大，又没有这项无障碍代价。

**逐行修复设置页。** 否决：每个功能都自带行样式，而选项栏过窄只有一个原因，即面板的双栏布局。

## 影响

竖屏用户保有完整的对话宽度，从左上角的座进入导航，选择会话后无需再次轻触即可回到对话。决策卡片可能多出一行页脚，以纵向空间换取可达的操作。固定定位的浮层（设置、菜单）不受根元素安全区域内边距影响；设置面板自行设置内边距，菜单则锚定于其触发控件。右侧面板保留上游的窄屏规则，以全屏打开。iOS Safari 不会因屏幕键盘调整布局，而是把聚焦的输入框滚动到可见位置。

布局单元测试固定了零宽列、浮层宽度与留白、遮罩和导航触发的关闭、回到断点以上时恢复控制栏，以及保持不变的 macOS 与 Windows 桌面布局。[phone-shell Web 场景](../../../../apps/web/tests/phone-shell.e2e.ts)在 390×844 的触屏页面上测量导航、宽 Markdown 的约束、16px 草稿文字和堆叠后的设置面板。审批、问题与 plan-review 回放场景在 `mobile.expected.md` golden 中记录竖屏下的卡片约束。
