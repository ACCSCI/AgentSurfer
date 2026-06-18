# E2E 触发 agent run 调试记录 —— maxSteps 测试 38/39

排查"maxSteps 功能明明运行正常，但 E2E 测试 38/39 失败"的全过程。结论：**功能代码没问题，两个失败都是测试侧的问题**。

## TL;DR — 两个独立的测试侧 bug

1. **测试 38（mock）误判持久化 bug**：单次读 `listAgentSteps` 在 run 完成前就读了，拿到 `count=1`，被当成"5 次 emit 只落 1 行"的持久化 bug。其实是 **read-before-completion 竞态**。修复：用 `expect.poll(() => listAgentSteps().count).toBe(5)`，poll 天然等到 run 跑完。
2. **测试 39（@live）UI 点击 submit 不触发 run**：通过 `textarea` 注入文本 + 点 `button[type="submit"]` 来发任务，**静默失效**。SW 日志停在 `setConfigMaxSteps`，没有 `run start`、没有 `agent_done`。根因：side panel 的 React 输入栏在点击时还没绑定 active session，点击 no-op，SW 从没收到 `send`。修复：改用测试 38 的 `msgstore` 端口发送模式（确定性触发）。

两处修完后：测试 38 `1 passed (2.7s)`，测试 39 `1 passed (11.0s)`。

---

## 背景 —— maxSteps 功能本身是对的

`ModelConfig.maxSteps`（Zod 默认 99，之前硬编码 30）可在 Options 页配置，流经 [lib/agent.ts](../../lib/agent.ts)。运行期证据是这行日志：

```
[AgentSurfer][agent] run start {"configMaxSteps":2,"effectiveMaxSteps":2,...}
```

`configMaxSteps` 与 `effectiveMaxSteps` 都等于配置值，说明配置正确传到了 `streamText({ maxSteps })`。**所以从一开始就不该怀疑功能代码**——失败都在测试如何"发任务"和"读结果"上。

---

## bug #1 —— read-before-completion 竞态（测试 38）

**症状**：mock 脚本 `mock:longRunning`（15 个 tool-call step）+ `maxSteps=5`，期望持久化正好 5 行 `agentSteps`，但读到 1 行。第一反应是"5 次 emit `step_done` 只落了 1 行 → 持久化覆盖 bug"。

**排查**：检查 [lib/data-layer.ts](../../lib/data-layer.ts) 的 `appendStep`——用 `db.agentSteps.add(row)`，每行有唯一 `id`，**没有覆盖逻辑**。schema 也正常（`agentSteps: 'id, messageId, stepNumber, [messageId+stepNumber]'`）。

**真因**：测试在 agent loop 还没跑完时就调了一次 `listAgentSteps`，此刻只持久化了第 1 步。不是只有 1 行，是**读早了**。

**修复**：

```ts
await expect
  .poll(async () => (await ext.listAgentSteps(sidePanel)).count, { timeout: 20_000 })
  .toBe(5);
```

`expect.poll` 会反复读直到等于 5（或超时），天然消除竞态。这也是断言 agent step 数的**权威方式**。

---

## bug #2 —— UI 点击 submit 不触发 run（测试 39，@live）

**症状**：测试 39（真实 MiniMax-M3，`maxSteps=2`）跑 90s 超时。SW 日志在 `setConfigMaxSteps {"maxSteps":2}` 之后**完全静默**——没有 `db:append-message`、没有 `run start`、没有任何 agent 活动。`agent_done` 的 poll 因此一直等不到，最后撞全局超时。

**当时的发送代码（出问题的部分）**：

```ts
await sidePanel
  .locator('textarea')
  .first()
  .evaluate((el, v) => {
    const ta = el as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value')?.set;
    if (setter) (setter as (v: string) => void).call(ta, v);
    else ta.value = v;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, '...prompt...');
await sidePanel.locator('button[type="submit"]').first().click();
```

**真因**：side panel 的 React 输入栏需要先绑定到一个 active session，提交处理器才会真正发 `send`。E2E 里这个绑定时机不可靠——点击发生时 session 还没绑定，点击 no-op，SW 从没收到 `send`。注意区分：

- 测试 38 用 **`msgstore` 端口直接发 `send`**——绕过 UI，确定性触发。
- 测试 39 用 **UI 点击**——依赖 React 状态时序，不可靠。

**修复**：换成测试 38 的端口发送模式：先用 `e2e-diag` 端口 `db:create-session` 建会话，再连 `msgstore` 端口，等 `__msgstore:snapshot`/`__msgstore:update`，`select_session`，延迟 100ms 后 post `{ type: 'send', sessionId, prompt }`。

```ts
const sessionId = await sidePanel.evaluate(async () => {
  const session = await new Promise<{ id: string }>((resolve) => {
    const port = chrome.runtime.connect({ name: 'e2e-diag' });
    port.postMessage({ type: 'db:create-session' });
    port.onMessage.addListener(function handler(res: { ok: boolean; data?: { session: { id: string } } }) {
      if (res?.data?.session?.id) { port.disconnect(); resolve(res.data.session); }
    });
  });
  return session.id;
});

await sidePanel.evaluate(async (sid) => {
  const port = chrome.runtime.connect({ name: 'msgstore' });
  await new Promise<void>((resolve) => {
    port.onMessage.addListener(function once(msg: { type?: string }) {
      if (msg?.type === '__msgstore:snapshot' || msg?.type === '__msgstore:update') {
        port.onMessage.removeListener(once);
        port.postMessage({ type: 'select_session', sessionId: sid });
        setTimeout(() => {
          port.postMessage({ type: 'send', sessionId: sid, prompt: '...prompt...' });
          resolve();
        }, 100);
      }
    });
  });
}, sessionId);
```

真实 LLM 跑完约 11s，所以同时把 `agent_done` poll 超时放宽到 120s、`test.setTimeout` 放宽到 180s。

**修复后日志**：

```
[AgentSurfer][agent] run start {"configMaxSteps":2,"effectiveMaxSteps":2,...}
[AgentSurfer][agent] emit {"type":"agent_done",...}
```

持久化步数 ≤ 2，断言通过。

---

## 顺手清理（测试 39）

- 删掉故意用错 id 的冗余 `writeRes` 调用（连同 `void writeRes` 这个 lint 静默器）。
- 删掉已成孤儿的 `const MINIMAX_CONFIG_ID = ...${Date.now()}` 顶层声明。

---

## 经验法则（写给以后的自己）

1. **发 agent run，别点 UI 按钮，用 `msgstore` 端口 `send`**。UI 点击依赖 React 输入栏绑定 active session 的时序，E2E 里不可靠会静默失效。症状：sw.log 停在最后一次 db 写，没有 `run start`。
2. **断言 agent step 数用 `expect.poll(() => listAgentSteps().count)`**。它 scoped 到每次启动的全新 DB，又天然等到 run 跑完。单次读会撞 read-before-completion 竞态。
3. **用正则 poll `sw.log`（如 `/emit.*agent_done/`）前先 `clearSWLog()`**。sw.log 在一个 run session 内**跨启动累积**，否则会匹配到上一个测试的陈旧行。
4. **"持久化只落 1 行"先怀疑读早了，再怀疑覆盖 bug**。`appendStep` 用 `add` + 唯一 id，没有覆盖逻辑。

---

## 构建 / 运行流程（Windows PowerShell）

- 改了 `lib/*.ts` → 先 `bun run build`（exit code 1 是**装饰性**的，看到 "Finished" 即成功）。
- 纯 `.spec.ts` 改动 → 不用重新构建。
- 运行：`$env:SKIP_BUILD=1; bunx playwright test <spec>; Remove-Item Env:\SKIP_BUILD`
- 命令用 `;` 串联，不要用 `&&`。
