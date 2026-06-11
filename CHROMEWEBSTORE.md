# AgentSurfer — Chrome Web Store Listing

> Source of truth for everything that goes into the Chrome Developer Dashboard.
> Update this file whenever the user-facing surface, permissions, or privacy posture changes.

## 1. Product name & short description

- **Name**: AgentSurfer
- **Short name**: AgentSurfer
- **Category**: Productivity
- **Language**: English (primary)

## 2. Tagline (≤ 132 chars)

Drive any webpage with plain English. Six LLM providers, one side panel.

## 3. Detailed description (no implementation details, lead with function)

AgentSurfer puts a browser-automation assistant in your Chrome side panel. Type what you want, and the agent reads the active tab, takes screenshots, clicks buttons, fills forms, and reports back — all driven by a large language model you choose.

- Six built-in LLM providers: OpenAI, Anthropic, two OpenAI-compatible endpoints, Xiaomi MiMo, and MiniMax. Add your own API key once and switch between them whenever you like.
- The agent sees what you see. It captures the active tab and uses vision models to understand the layout before acting.
- Every action is a tool call you can read. The side panel shows each step the model took and why.
- You stay in control. Sensitive actions (entering passwords, confirming destructive flows) require you to type the value in the chat.
- Local-first. Chat history, screenshots, and API keys live in your browser's IndexedDB. Nothing is sent to a server we control.

## 4. Permissions justification (plain English)

> The Chrome Web Store review team rejects vague reasons. Each item below must clearly state what the user gets.

| Permission / host_permission | Why we need it |
|---|---|
| `tabs` | To detect which tab is active and to read its URL/title so the agent knows where to act. |
| `scripting` | To run the agent's "look at the page" and "click the button" commands inside the active tab. Without this, the agent cannot interact with any page. |
| `storage` | To remember your preferred LLM provider and model between sessions. |
| `sidePanel` | To open the AgentSurfer chat UI next to the page you're working on. |
| `host_permissions: <all_urls>` | The agent must work on the page you point it at, which can be any site. The user always initiates the action — the agent never visits a page on its own. |

## 5. Data use disclosure

| Data | Sent off-device? | Where |
|---|---|---|
| Page text, screenshots, and the URL of the active tab | **Yes** — only while a run is in progress, only to the LLM provider the user configured | OpenAI / Anthropic / user's OpenAI-compatible endpoint / Xiaomi MiMo / MiniMax |
| API keys | **No** | Stored in the browser's IndexedDB. Never transmitted to anyone except the provider they belong to. |
| Chat history, agent steps, screenshots | **No** | Stored in the browser's IndexedDB. Never transmitted. |
| Crash reports, analytics, telemetry | **No** | We do not collect any. |

## 6. Privacy policy

Host: `https://github.com/ACCSCI/AgentSurfer/blob/main/PRIVACY.md` (also bundled inside the extension at `PRIVACY.md`).

See `PRIVACY.md` in the repo for the full text. The page must be reachable from a stable URL before submitting.

## 7. Single purpose

AgentSurfer is a **browser-automation assistant** powered by a user-chosen LLM. Its single purpose is to read, summarize, and operate on the active web page in response to natural-language instructions from the user.

## 8. Version history

| Version | Date | Summary |
|---|---|---|
| 0.1.0 | 2026-06-11 | Initial release. Side panel chat, six LLM providers, DOM and screenshot tools, local-first persistence. |

## 9. Asset checklist

- [x] Icons: `public/icon/16.png`, `32.png`, `48.png`, `128.png` (white background, red "O")
- [ ] **Screenshots** (1280×800): required before first submission
  - Screenshot 1: chat thread showing the agent reasoning through a multi-step task
  - Screenshot 2: the options page with provider dropdown and key entry
  - Screenshot 3: a step trace panel showing tool calls and results
- [ ] Marquee promo tile (440×280) — optional
- [ ] Small promo tile (440×280) — optional

## 10. Pre-publish checklist

- [ ] Privacy policy URL is live
- [ ] All 4 icon sizes render at the correct pixel dimensions
- [ ] At least one 1280×800 screenshot exists
- [ ] ZIP excludes `.git/`, `node_modules/`, `.env`, `CHROMEWEBSTORE.md`
- [ ] `wxt build` produces no warnings
- [ ] Manifest has no leftover debug permissions
- [ ] Tested with `bun run e2e` (mock LLM)
- [ ] Manual test with at least one real LLM provider
- [ ] Single-purpose description is honest and clear
