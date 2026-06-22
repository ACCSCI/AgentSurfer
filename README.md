# AgentSurfer

AI-powered browser agent — control any webpage with natural language. Six LLM providers, one side panel.

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blue)](https://github.com/ACCSCI/AgentSurfer)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## What it does

AgentSurfer puts a browser-automation assistant in your Chrome side panel. Type what you want, and the agent reads the active tab, takes screenshots, clicks buttons, fills forms, and reports back — all driven by a large language model you choose.

- **6 LLM providers** — OpenAI, Anthropic, OpenAI-compatible endpoints, Xiaomi MiMo, MiniMax, and StepFun (阶跃星辰). Add your API key once and switch anytime.
- **Visual understanding** — the agent captures the active tab and uses vision models to understand the layout before acting.
- **Transparent reasoning** — every action is a tool call you can read. The side panel shows each step the model took and why.
- **User control** — sensitive actions (passwords, destructive flows) require you to confirm.
- **Local-first** — chat history, screenshots, and API keys live in your browser's IndexedDB. Nothing is sent to a server we control.

## Quick start

### Prerequisites

- [Bun](https://bun.sh) (package manager + runtime)
- [Node.js](https://nodejs.org) ≥ 18

### Install & build

```bash
bun install
bun run build
```

### Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `.output/chrome-mv3/`
4. Click the AgentSurfer icon in the toolbar → the side panel opens

### Configure an LLM

1. Click the ⚙️ icon in the side panel (or open the Options page)
2. Select a provider and enter your API key
3. Save — you're ready to go

### Development

```bash
bun run dev          # hot-reload dev mode (WXT)
bun run compile      # type-check
bun run lint         # biome check
```

### E2E testing

```bash
# Mock LLM (CI-friendly, no API key needed)
bun run build && SKIP_BUILD=1 bun run e2e

# Real LLM (requires API key in .env)
bun run build && SKIP_BUILD=1 bun run e2e:live

# Single spec
bun run build && SKIP_BUILD=1 bun run e2e e2e/specs/01-sidepanel-opens.spec.ts

# Debug (headed)
bun run build && SKIP_BUILD=1 bun run e2e:debug
```

### Environment variables

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `MINIMAX_API_KEY` | For MiniMax provider | Get at [platform.minimaxi.com](https://platform.minimaxi.com/user-center/basic-information/keys) |
| `MIMO_API_KEY` | For Xiaomi MiMo provider | Get at [platform.xiaomimimo.com](https://platform.xiaomimimo.com/user-center/api-keys) |
| `STEPFUN_API_KEY` | For StepFun provider | Get at [platform.stepfun.com](https://platform.stepfun.com/user-center/basic-information/keys) |

## Architecture

```
entrypoints/
  background.ts          # MV3 Service Worker — message routing, data layer writes
  content.ts             # Content script — page interaction bridge
  sidepanel/             # Side panel UI (React + shadcn/ui)
  options/               # Options page (React)

lib/
  agent.ts               # Per-run setup: model, tools, checkpoint, wall timeout
  llm.ts                 # LLM factory — ModelConfig → Vercel AI SDK LanguageModel
  tools.ts               # Tool definitions (click, type, screenshot, aim, etc.)
  cdp.ts                 # Chrome DevTools Protocol service (CDPService)
  a11y-tree.ts           # Accessibility tree snapshot + element lookup
  data-layer.ts          # WRITE-only Dexie functions (Service Worker only)
  db.ts                  # Dexie schema + READ-only helpers
  message-store.ts       # Streaming message accumulator
  runtime/               # Agent runtime (lifecycle, loop, events, checkpoint)
    runtime.ts           # start/pause/resume/cancel, AbortController map
    loop.ts              # streamText + consumeStream, chunk fanout
    events.ts            # 12 distinct RuntimeEvent types
    checkpoint.ts        # chrome.storage.session persistence (survives SW restarts)
    verifier.ts          # Post-run verification (fire-and-forget)
    tool-registry.ts     # buildEnabledTools(agent.tools ∩ userEnabled, emit)
  agents/                # Agent definitions (plain data, no state)
    browser-agent.ts     # Production agent — ~310-line system prompt
    index.ts             # getAgent(name) registry

stores/                  # Zustand stores (Side Panel / Options only)
types/                   # TypeScript types (session, model, messages, agent)
e2e/                     # Playwright E2E tests (real Chrome instance)
```

### Key design principles

- **Runtime is event-driven** — no request/response, no direct method calls. Output flows through 12 distinct event types.
- **Runtime never touches UI state** — Runtime writes to Dexie; UI reads via `useLiveQuery` and `useChangeCount`.
- **Service Worker is stateless** — no module-level variables. All state lives in `chrome.storage.session` or Dexie.
- **Tool errors are Observations, not failures** — the LLM decides what to do next.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Build | [WXT](https://wxt.dev) (MV3 Chrome Extension) |
| Runtime | [Bun](https://bun.sh) |
| UI | [React](https://react.dev) 18 + [shadcn/ui](https://ui.shadcn.com) + [Tailwind CSS](https://tailwindcss.com) |
| State | [Zustand](https://github.com/pmndrs/zustand) (UI) + [Dexie](https://dexie.org) (IndexedDB) |
| LLM | [Vercel AI SDK](https://sdk.vercel.ai) v6 |
| Testing | [Playwright](https://playwright.dev) |
| Linting | [Biome](https://biomejs.dev) |
| Types | [Zod](https://zod.dev) v4 |

## Supported LLM providers

| Provider | Models | Notes |
|----------|--------|-------|
| **OpenAI** | GPT-4o, GPT-4.1, o3, etc. | Native via `@ai-sdk/openai` |
| **Anthropic** | Claude Sonnet 4, Opus 4, etc. | Native via `@ai-sdk/anthropic` |
| **OpenAI-compatible** | Any OpenAI API-compatible endpoint | Custom base URL + key |
| **Xiaomi MiMo** | MiMo-M3 | Vision-capable, strong at tool calling |
| **MiniMax** | MiniMax-M3 | Vision + reasoning support |
| **StepFun** | step-3.7-flash | Reasoning via `<think>` sentinels |

## Privacy

See [PRIVACY.md](PRIVACY.md) for the full policy. Key points:

- **No tracking, no analytics, no telemetry.**
- Page content is sent **only** to the LLM provider you configured, **only** while a run is in progress.
- API keys and chat history never leave your browser.

## License

MIT
