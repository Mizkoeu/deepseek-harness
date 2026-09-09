# @deepseek-ai/dsh-session-last-turn-outcome

[English](README.md) | 中文

注册 `lastTurnOutcome` 投影单元的函数插件：一个对 `turn/end` 事件的后者胜折叠，把每个回合的 `TurnEndReason` 映射为一个粗粒度结果，并经会话投影缝合面（注册表快照、变更馈送，以及每个投影载体：历史尾页、`session/projection` 推送帧、会话列表行）提供。跨工作区分诊 UI 读取它来标记停滞会话；`./types` 和 `./client` 子路径为宿主与客户端聚合再导出单一来源的 `lastTurnOutcome` 键声明，而不把宿主端的值导入拉进客户端程序。

## 折叠语义

- 在首个 `turn/end` 之前该值为 `null`，此后为最近结束回合的结果。已组合的注册表总是提供该键，因此客户端读取的是值，而非键是否存在。
- 原因类别粗粒度映射：`completed` → `normal`；`aborted`/`interrupted` → `interrupted`；`error` → `error`；`max-tokens` → `max-tokens`；`blocked` → `blocked`；任何未列出的原因 → `normal`。分诊消费者把 `error`/`max-tokens`/`interrupted` 视为需要关注。
- 后者胜：一个先出错、后来被恢复到干净完成的会话会再次读到 `normal`。运行中的回合尚无 `turn/end`，因此在当前回合关闭前该值反映上一个已完成的回合。
- 当类别未变时折叠返回先前的 state 引用，因此结果不变则不发出新的投影值。

## 组合

```yaml
- id: session-last-turn-outcome
  name: '@deepseek-ai/dsh-session-last-turn-outcome'
```

注入 `sessionProjections`——这是插件的全部目的；在没有该注册表的组合中，fiber 保持 pending，什么都不注册。

## 模型体验

无，因为该插件只计算一个面向客户端、对已记录 `turn/end` 事件的读模型，不触及任何 prompt、消息、schema、流或工具结果。

#### KV Cache 影响

无；该插件从不组装或发送提供方请求。

## 已知限制与延期工作

- **结果是整会话后者胜，而非按回合历史**——只保留最近回合的粗粒度结果；需要过往结果序列的消费者读日志，而非此投影。
- **`turn/end` 原因的归属在别处**——该事件及其 `TurnEndReason` 由 dsh-agent-loop 和会话表面拥有并做运行时校验；未识别的原因类别在此粗化为 `normal`，而非失败。
- **在分诊消费它的地方挂载**——未组合该插件的组合不提供 `lastTurnOutcome` 键，其消费者从此来源得不到停滞会话信号。
