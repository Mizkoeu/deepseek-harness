# Agent Note: Web GUI 目录选择器默认使用 browse

Status: implemented

[English](2026-08-19-web-directory-picker-default-browse.md) | 中文

## Problem

`dsh-web-app` bundle 曾通过 [`-auto`](../../implemented/feature/2026-07-29-directory-picker-adaptive-default.md)（自适应选择器）挂载其工作区目录选择器。`-auto` 在服务器绑定 loopback、未经 SSH 启动、且运行于 darwin/win32 时解析为 `native`——它把 loopback 绑定当作操作者能看到宿主显示屏的证据。但 web 应用拒绝非 loopback 绑定（`--host 0.0.0.0` 被拒绝，因为它会把远程代码执行暴露到网络），所以 loopback 是它唯一可能的绑定，而这个事实并不携带任何关于操作者位置的信息。每一个非本地客户端——通过 `tailscale serve` 的手机、通过 `ssh -L` 的笔记本、任何反向代理——都是经由隧道到达这台 loopback 服务器，并以 `127.0.0.1` 的身份抵达。

因此，在本地启动的 macOS 或 Windows 服务器上（启动环境中没有 SSH 标记），`-auto` *总是* 解析为 `native`，而它的操作系统文件夹选择框会在服务器自己的显示屏上打开——对实际访问 GUI 的远程浏览器而言不可见、也无法驱动。操作者点击 **Add workspace**，一个对话框在无人值守的桌面上弹出，而他们的屏幕上什么也没发生：无法创建工作区。该问题由一部 iPhone 经 `tailscale serve` 访问某台 Mac 的 `dsh web` 时报告，`tailscale serve` 将 tailnet 来源代理到 `http://127.0.0.1:3080`。

## Decision

`dsh-web-app` bundle 直接挂载 `-browse` 交互——宿主端 `directory-picker-browse` 加客户端 `ui-directory-picker-browse`——而不再是 `-auto`。应用内对话框在网页内部列举并创建文件夹，因此它服务于经由任意隧道到达的浏览器，而这正是非本地客户端到达这台 loopback 绑定服务器的唯一方式。`native` 与 `-auto` 仍是可组合的 pin：两个包都保留为 bundle 的依赖。overlay 可禁用这两条 browse 行，并插入 `-native` 的宿主+客户端配对（`directory-picker-native` 加 `ui-directory-picker-native`）以 pin 住面向坐在宿主机旁操作者的 OS 选择框，或仅插入宿主端 `directory-picker-auto` 一行以恢复启动期检测——`-auto` 采样启动期的绑定主机、SSH 标记、平台与显示屏，随后自行挂载所选的宿主后端及其客户端界面。

这一改动反转的是自适应默认决策中 *随附默认值* 的那一半。`-auto` 选择器包及其「一行同时切换两侧」的 seam 机制保持不变，仍作为可组合选项随附；改变的只是 web bundle 默认挂载哪种交互。

## Alternatives considered

- **保留 `-auto` 并改良其解析器。** 已否决：`-auto` 的 `native` 分支把 loopback 绑定读作「操作者就在宿主显示屏前」的正向信号，但禁止全接口绑定使 loopback 成为 web 应用唯一可能的绑定，因此任何启动期改良都无法区分本地操作者与经隧道而来的远程操作者。
- **按连接自适应**（同一台服务器上，对 loopback 来源的请求解析 `native`，对远程来源解析 `browse`）。已否决：隧道以 loopback 转发，因此请求来源同样无法区分本地浏览器与远程浏览器；这还需要同时挂载两套客户端流程以及 seam 已刻意删除的线路广告，而自适应默认那篇 note 已将其搁置。
- **重新引入 `--directory-picker=auto|native|browse` 强制标志** 而非改变默认值。已搁置：overlay 已能 pin 住任意后端，而所报告的故障是常见远程浏览器场景下 *默认值* 的错误，而非缺少覆盖手段。若某个部署需要不用 overlay 就强制某个后端，该标志可以再回来。

## Consequences

- 普通的 `dsh web` 在每台宿主上都提供应用内选择器。坐在机器旁、偏好 OS 选择框的操作者可通过 overlay pin 住 `-native`——这与此前的默认相反，在旧默认下有人值守的本地宿主开箱即得 OS 选择框。
- 浏览器 e2e/snapshot lane 不再 pin `-browse`（`apps/web/tests/scaffold.ts`），而是演练随附默认值。web-agent-presets 组合测试与真实宿主 smoke（`apps/web/tests/smoke-real.e2e.ts`）同样撤去各自的 pin，`apps/web/tests/pin-browse-picker.overlay.yml` 被删除。
- 该 lane 本身无法守护这个选择：它运行在 Linux CI 上，那里 `-auto` 自身也会解析为 `browse` 并通过。宿主无关的守护是一条针对随附 bundle patch 的单元断言（`packages/bundle/web-app/tests/directory-picker.spec.ts`）：若 bundle 挂载了 `-auto` 或 `-native`，它就失败。
- `verify-cordis-config` 的 chooser 规则（挂载 `-auto` 就必须声明两个 backend 为依赖）不再对 `dsh-web-app` 生效，因为它不再挂载 `-auto`。browse 的宿主行与客户端行是普通的 bundle 依赖；`-native` 与 `-auto` 仍作为 pin 目标保留声明（knip 忽略该 bundle 的 `@deepseek-ai/.+` 依赖）。
- 在随附 bundle 中引用 `ui-directory-picker-browse` 要求为其添加 `tsconfig.base.json` 的 `paths` 条目（源码启动解析门面），以便 `pnpm dsh web` 将其解析到 workspace 源码，与其他所有客户端 roster 包保持一致。
