# 38-history-load — 手动烟雾测试

`e2e/specs/38-history-load.spec.ts` 是结构性的：它只断言 `history loaded` 日志显示
正确的计数和角色顺序，**不**断言 LLM 真的"用"了历史来回答问题。

这一步靠你拿真 LLM 跑一次。

## 步骤

```bash
# 1. 确认 .env 有 API key
cat .env  # 应该有 MINIMAX_API_KEY=...

# 2. 重新 build（如果你刚改完代码）
npm run build

# 3. 加载 unpacked 到 Chrome，开 side panel
#    (npm run dev 或手动加载 .output/chrome-mv3)

# 4. 在 options 里配好真 LLM (默认 MiniMax-M3)

# 5. 侧边栏里发："我的名字叫小明"
#    → 看到 AI 回复（任意内容都行）

# 6. 再发："我叫什么名字？"
#    → **必须**回答包含"小明"或"你叫小明"或类似
#    → 如果它反问"你叫什么？"或者瞎编一个名字 = BUG 没修好
```

## 失败时怎么查

`history loaded` 日志应该至少出现两次。读 `.e2e-logs/sw.log`，
找这两个 grep：

```bash
grep "history loaded" .e2e-logs/sw.log
grep "msgstore snapshot" .e2e-logs/sw.log
grep "streamText messages" .e2e-logs/sw.log
```

**症状 → 修法**（按 §3 决策树）：

| 现象 | 原因 | 修法 |
|---|---|---|
| turn 2 的 `history loaded count=0` | helper 过滤错了 | 看 helper 是不是把已完成消息也当 draft 跳了 |
| `msgstore snapshot total=0` (turn 2) | 上游坏了：addUserMessage 没跑、sessionId 错配、SW 重启 buffer 空了 | 查 runAgentInner 步骤 1 是不是被跳过 |
| 三条日志都对，LLM 还是答错 | LLM 没读懂消息格式 | 多半是 `tool-call` 拼错（缺 toolName / args） |
| `history loaded count=2` 但 totalChars 异常大 | 老历史没截断，撑爆 token 窗 | 改 `maxMessages` 或加 token-budget 截断 |
| `history loaded` 根本没出现 | loop 改动没生效 / 编译没更新 | 确认 `bun run compile` 干净、`wxt build` 已重 build |

## 已知限制

- 当前没有 `maxMessages` token-budget 截断——长会话下 LLM 会被喂很多消息。
  如果你发现真 LLM 答非所问但日志显示消息数对，多半是上下文被压成 attention 的边角料。
  解法：见 `lib/runtime/history.ts` 的 `maxMessages` 参数（默认 50）。
- 失败的 `tool_call` 已经被作为 `role:'tool'` 消息带 `isError:true` 喂回 LLM。
  这对调试"上次调用为什么失败"有用。
- Reasoning 内容（`ReasoningPart`）会被原样回传给 LLM。
  如果觉得太啰嗦可以在 `history.ts` 的 `bufferToCore` 里跳过 reasoning。
