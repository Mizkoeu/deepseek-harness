# Agent Note: 可信远程设备可访问 /api 的特权方法

Status: implemented

[English](2026-08-19-trusted-remote-privileged-actions.md) | 中文

## Problem

Web GUI 的 `/api` 特权方法集——原生宿主对话框（`host.pickDirectory`、`host.openPath`）、整个 settings 与 credential 配置面（`settings.describe`/`openDocument`/`update`/`replace`/`mutate`、`credentials.describe`/`set`/`unset`）、`llm.discoverModels`，以及 agent（智能体） preset 的创作方法——过去以空信任列表通过浏览器信任 fence，从而即便在已声明 `trustedHosts` 的部署上也被钉在回环。[配置面](2026-07-30-config-plane-boundaries.md)与[草稿发现](2026-08-04-draft-provider-endpoint-interrogation.md)两项决策之所以这样钉，是因为 `trustedHosts` 是 DNS 重绑定 fence，而非认证，且当前尚无认证层。

其后果是：一个人在一台机器上运行 `dsh web`，再从自己的手机或笔记本经私有隧道访问它——所报告的情形是从 iPhone 经 `tailscale serve` 访问一台 Mac——可以浏览并驱动会话，也可以通过应用内 browse 选择器选择工作区目录（其 `list`/`create` 操作不在特权集内），却无法使用原生 OS 目录对话框、打开或编辑设置、管理凭据或发现模型。这些正是远程优先用户所需的其余初始配置操作。回环钉死让普通 `/api` 面——包括应用内 browse 选择器——可远程使用，却把原生对话框与配置面挡在门外，且没有任何选择加入的途径。

## Decision

特权方法集与其余每个 `/api` 调用一样，都以配置的 `trustedHosts` 允许列表通过同一信任 fence，而不再以空的（仅限回环的）列表。在已声明可信授权的部署上，凡 `Host` 为回环或某个已声明 `trustedHosts` 条目、且不携带不可信 `Origin`、也不带 `sec-fetch-site: cross-site` 标记的请求，都可到达这些方法；任何不可信或被重绑定的 `Host` 仍在派发前以 403 拒绝。DNS 重绑定与跨站 fence（`packages/client/connection/src/api-request-trust.ts`）保持不变；仅 `apply`（`packages/client/connection/src/index.ts`）中特权分支上的回环钉死被放宽为遵循 `trustedHosts`。

哪些方法属于特权、以及读取配置也算特权，均与本 note 部分取代的那项配置面决策一致，未作改变。`credentials.describe` 仍只报出某条命名环境引用是否已配置、以及它从何处解析——是其元数据，绝非密文值。模型目录（`llm.providers`、`llm.models`）与 `agentPreset.list`/`select` 仍不在特权集内。

这是一次部分取代，其适用范围限定为个人可信设备部署。`trustedHosts` 仍是 DNS 重绑定可达性 fence，明确不是认证：它区分的是可信授权与被重绑定的域名，而非区分某台设备或某个人与另一台设备或另一个人。因此每一台既能在网络上抵达服务器、又能出示可信 `Host` 头的设备都握有完整的特权权限——它可以读取 settings 面、探测命名的凭据引用、设置与清除凭据、驱动原生宿主对话框，并让宿主抓取调用方选定的 URL。这次放宽并未增加会话本已授予之外的权限：默认 agent 带着 `bash` 与文件系统工具，任何能启动会话的调用者都已能以本进程身份运行命令。这项既有能力正是该部署已经作出的信任假设；它是「同一份信任在此同样适用」的佐证，而非「准入远程设备是安全的」的证明。只有当每一台被允许的设备都被作为本进程的管理员来信任时，该部署才是恰当的。绑定仍仅限回环（`--host 0.0.0.0` 被拒绝），且不得有任何公共隧道——Tailscale Funnel、公共反向代理或任何面向公网的转发——置于其前，因为该 fence 无法区分一个抵达服务器并出示了正确 `Host` 的公网访客与操作者本人。本 note 无法为某个部署的隧道 ACL 背书；该义务仍属操作者。

## Alternatives considered

- **保留回环钉死，仅记录该限制。** 已否决：这会让远程优先用户无法使用原生对话框、设置、凭据或模型发现——这些正是应用内 browse 选择器未覆盖的初始配置操作——除非改动源码，否则毫无选择加入之法。
- **一个类似 `--directory-picker` 的按方法强制标志。** 因超出需求而否决：特权集本就共享同一道 fence，而用户的诉求是把自己的可信设备准入到整套特权，而非逐个方法开关。
- **现在就引入认证层（令牌、按设备身份）。** 延后，而非否决：令牌的签发、存储与轮换是实打实的产品面。本改动在不预先决定该设计的前提下，为可信设备部署闭合了这道可用性缺口；而真正的认证层，正是这里「共享权限」告诫得以消解的条件。
- **按连接自适应**（对回环来源的请求给特权，对远程来源拒绝）。已否决：隧道以回环或以可信授权转发，因此请求来源无法区分本地浏览器与远程可信浏览器——与[目录选择器默认值](../feature/2026-08-19-web-directory-picker-default-browse.md)不再把回环绑定读作本地操作者证据的理由相同。

## Consequences

- 在 `trustedHosts` 部署上，可信远程设备可到达每个特权方法：原生 OS 目录对话框与 `host.openPath`、settings 与 credentials 页、模型发现，以及 agent preset 创作。应用内 browse 选择器本就可达，保持不变。纯回环部署不受影响——空的 `trustedHosts` 仍把该集合钉在回环。
- 整个配置与原生操作面的信任面，现在是那些既能抵达服务器、又能出示可信 `Host` 的设备的集合，且不经按设备认证即被共享。一个部署若新增了某台不可信设备可达的 `trustedHosts` 授权，就相应地扩大了这个面；恰当的配置是一条私有隧道，其每一台被允许的设备都被作为管理员信任，无公共 Funnel 或代理，仅回环绑定。
- 可信远程设备对 `credentials.describe` 的可达性，暴露的是凭据引用的元数据（是否已配置及其来源），而非凭据值。
- 连接守卫特权分支的覆盖现在双向断言：已声明的可信授权被准入（空 proxy 的载体 404 证明 fence 已通过），而不可信 `Host`、不匹配的 `Origin`，以及在已声明 Host 上带 `sec-fetch-site: cross-site` 标记，均各以 403 拒绝——覆盖手工拼装的请求与一台真实 HTTP 服务器（`packages/client/connection/tests/node-half.host.spec.ts`）。
- 部分取代[配置面边界](2026-07-30-config-plane-boundaries.md)、[web 配置面](2026-07-30-web-config-plane.md)与[草稿提供方端点询问](2026-08-04-draft-provider-endpoint-interrogation.md)中的「仅限回环」调用方限制；这些 note 保留其仍然有效的「哪些属于特权及其理由」的分类，并在此交叉链接。
