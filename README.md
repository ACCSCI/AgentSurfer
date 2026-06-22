# AgentSurfer

> AI 驱动的浏览器智能体 — 用自然语言控制任意网页。六大 LLM 提供商，一个侧边栏。
>
> AI-powered browser agent — control any webpage with natural language. Six LLM providers, one side panel.

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blue)](https://github.com/ACCSCI/AgentSurfer)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## 功能介绍 / What it does

AgentSurfer 将一个浏览器自动化助手放入 Chrome 侧边栏。输入你的需求，智能体会读取当前标签页、截图、点击按钮、填写表单并汇报结果 — 全部由你选择的大语言模型驱动。

AgentSurfer puts a browser-automation assistant in your Chrome side panel. Type what you want, and the agent reads the active tab, takes screenshots, clicks buttons, fills forms, and reports back — all driven by a large language model you choose.

- **六大 LLM 提供商** — OpenAI、Anthropic、OpenAI 兼容端点、小米 MiMo、MiniMax、阶跃星辰 (StepFun)。填一次 API Key，随时切换。
  **6 LLM providers** — OpenAI, Anthropic, OpenAI-compatible endpoints, Xiaomi MiMo, MiniMax, and StepFun. Add your API key once and switch anytime.
- **视觉理解** — 智能体会截取当前标签页并使用视觉模型理解页面布局后再行动。
  **Visual understanding** — the agent captures the active tab and uses vision models to understand the layout before acting.
- **推理过程透明** — 每个操作都是可读的工具调用，侧边栏展示模型每一步的操作和原因。
  **Transparent reasoning** — every action is a tool call you can read. The side panel shows each step the model took and why.
- **用户掌控** — 敏感操作（输入密码、执行破坏性流程）需要你手动确认。
  **User control** — sensitive actions (passwords, destructive flows) require you to confirm.
- **本地优先** — 聊天记录、截图和 API Key 均存储在浏览器 IndexedDB 中，不会发送到我们控制的任何服务器。
  **Local-first** — chat history, screenshots, and API keys live in your browser's IndexedDB. Nothing is sent to a server we control.

---

## 快速开始 / Quick start

### 环境要求 / Prerequisites

- [Bun](https://bun.sh)（包管理器 + 运行时）
- [Node.js](https://nodejs.org) ≥ 18

### 安装与构建 / Install & build

```bash
bun install
bun run build
```

### 加载到 Chrome / Load in Chrome

1. 打开 `chrome://extensions` / Open `chrome://extensions`
2. 开启 **开发者模式** / Enable **Developer mode**
3. 点击 **加载已解压的扩展程序** → 选择 `.output/chrome-mv3/`
   Click **Load unpacked** → select `.output/chrome-mv3/`
4. 点击工具栏中的 AgentSurfer 图标 → 侧边栏打开
   Click the AgentSurfer icon in the toolbar → the side panel opens

### 配置 LLM / Configure an LLM

1. 点击侧边栏中的 ⚙️ 图标（或打开选项页面）
   Click the ⚙️ icon in the side panel (or open the Options page)
2. 选择提供商并输入你的 API Key / Select a provider and enter your API key
3. 保存即可使用 / Save — you're ready to go

### 开发 / Development

```bash
bun run dev          # 热重载开发模式 / hot-reload dev mode (WXT)
bun run compile      # 类型检查 / type-check
bun run lint         # Biome 检查 / biome check
```

### E2E 测试 / E2E testing

```bash
# Mock LLM（CI 友好，无需 API Key）
# Mock LLM (CI-friendly, no API key needed)
bun run build && SKIP_BUILD=1 bun run e2e

# 真实 LLM（需要在 .env 中配置 API Key）
# Real LLM (requires API key in .env)
bun run build && SKIP_BUILD=1 bun run e2e:live

# 单个测试用例 / Single spec
bun run build && SKIP_BUILD=1 bun run e2e e2e/specs/01-sidepanel-opens.spec.ts

# 调试模式（有头浏览器）/ Debug (headed)
bun run build && SKIP_BUILD=1 bun run e2e:debug
```

### 环境变量 / Environment variables

将 `.env.example` 复制为 `.env` 并填入你的密钥：
Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

| 变量 / Variable | 用途 / Required for | 说明 / Description |
|---|---|---|
| `MINIMAX_API_KEY` | MiniMax 提供商 / MiniMax provider | [platform.minimaxi.com](https://platform.minimaxi.com/user-center/basic-information/keys) |
| `MIMO_API_KEY` | 小米 MiMo 提供商 / Xiaomi MiMo provider | [platform.xiaomimimo.com](https://platform.xiaomimimo.com/user-center/api-keys) |
| `STEPFUN_API_KEY` | 阶跃星辰提供商 / StepFun provider | [platform.stepfun.com](https://platform.stepfun.com/user-center/basic-information/keys) |

---

## 架构 / Architecture

```
entrypoints/
  background.ts          # MV3 Service Worker — 消息路由、数据层写入
  content.ts             # 内容脚本 — 页面交互桥接
  sidepanel/             # 侧边栏 UI（React + shadcn/ui）
  options/               # 选项页面（React）

lib/
  agent.ts               # 单次运行设置：模型、工具、检查点、超时
  llm.ts                 # LLM 工厂 — ModelConfig → Vercel AI SDK LanguageModel
  tools.ts               # 工具定义（点击、输入、截图、瞄准等）
  cdp.ts                 # Chrome DevTools Protocol 服务（CDPService）
  a11y-tree.ts           # 无障碍树快照 + 元素查找
  data-layer.ts          # 仅写入 Dexie 函数（仅 Service Worker 可用）
  db.ts                  # Dexie Schema + 仅读取辅助函数
  message-store.ts       # 流式消息累加器
  runtime/               # 智能体运行时（生命周期、循环、事件、检查点）
    runtime.ts           # 启动/暂停/恢复/取消，AbortController 管理
    loop.ts              # streamText + consumeStream，chunk 分发
    events.ts            # 12 种独立 RuntimeEvent 类型
    checkpoint.ts        # chrome.storage.session 持久化（SW 重启后仍有效）
    verifier.ts          # 运行后验证（fire-and-forget）
    tool-registry.ts     # buildEnabledTools(agent.tools ∩ userEnabled, emit)
  agents/                # 智能体定义（纯数据，无状态）
    browser-agent.ts     # 生产智能体 — ~310 行系统提示词
    index.ts             # getAgent(name) 注册表

stores/                  # Zustand 状态管理（仅侧边栏 / 选项页面）
types/                   # TypeScript 类型（session、model、messages、agent）
e2e/                     # Playwright E2E 测试（真实 Chrome 实例）
```

### 核心设计原则 / Key design principles

- **运行时事件驱动** — 无请求/响应模式，无直接方法调用。输出通过 12 种独立事件类型流动。
  **Runtime is event-driven** — no request/response, no direct method calls. Output flows through 12 distinct event types.
- **运行时不触碰 UI 状态** — Runtime 写入 Dexie；UI 通过 `useLiveQuery` 和 `useChangeCount` 读取。
  **Runtime never touches UI state** — Runtime writes to Dexie; UI reads via `useLiveQuery` and `useChangeCount`.
- **Service Worker 无状态** — 无模块级变量。所有状态存储在 `chrome.storage.session` 或 Dexie 中。
  **Service Worker is stateless** — no module-level variables. All state lives in `chrome.storage.session` or Dexie.
- **工具错误是观察结果，不是失败** — 由 LLM 决定下一步操作。
  **Tool errors are Observations, not failures** — the LLM decides what to do next.

---

## 技术栈 / Tech stack

| 层 / Layer | 技术 / Technology |
|---|---|
| 构建 / Build | [WXT](https://wxt.dev)（MV3 Chrome Extension） |
| 运行时 / Runtime | [Bun](https://bun.sh) |
| UI | [React](https://react.dev) 18 + [shadcn/ui](https://ui.shadcn.com) + [Tailwind CSS](https://tailwindcss.com) |
| 状态管理 / State | [Zustand](https://github.com/pmndrs/zustand)（UI）+ [Dexie](https://dexie.org)（IndexedDB） |
| LLM | [Vercel AI SDK](https://sdk.vercel.ai) v6 |
| 测试 / Testing | [Playwright](https://playwright.dev) |
| 代码检查 / Linting | [Biome](https://biomejs.dev) |
| 类型 / Types | [Zod](https://zod.dev) v4 |

## 支持的 LLM 提供商 / Supported LLM providers

| 提供商 / Provider | 模型 / Models | 备注 / Notes |
|---|---|---|
| **OpenAI** | GPT-4o, GPT-4.1, o3 等 | 原生支持 `@ai-sdk/openai` |
| **Anthropic** | Claude Sonnet 4, Opus 4 等 | 原生支持 `@ai-sdk/anthropic` |
| **OpenAI 兼容** / OpenAI-compatible | 任何 OpenAI API 兼容端点 | 自定义 Base URL + Key |
| **小米 MiMo** / Xiaomi MiMo | MiMo-M3 | 支持视觉，工具调用能力强 |
| **MiniMax** | MiniMax-M3 | 支持视觉 + 推理 |
| **阶跃星辰** / StepFun | step-3.7-flash | 通过 `<think>` 标记透传推理 |

---

## 隐私政策 / Privacy

详见 [PRIVACY.md](PRIVACY.md)。要点：
See [PRIVACY.md](PRIVACY.md) for the full policy. Key points:

- **无追踪、无分析、无遥测。**
  **No tracking, no analytics, no telemetry.**
- 页面内容**仅**发送给你配置的 LLM 提供商，**仅**在运行期间发送。
  Page content is sent **only** to the LLM provider you configured, **only** while a run is in progress.
- API Key 和聊天记录永远不会离开你的浏览器。
  API keys and chat history never leave your browser.

---

## 许可证 / License

MIT
