# `cdpAim` 调试实验记录

排查"aim 总落在右下角"的全过程，按时间顺序记录。每个结论都附有可复现的脚本/截图路径。

## TL;DR — 至少三个独立 bug

1. **模型选错**：之前默认 `MiniMax-M2.7-highspeed`，M2.7 系列**不支持 image 输入**（Anthropic 兼容文档明文），LLM 之前一直在盲猜。
2. **data URL 前缀没剥**：`ToolResultContent` 里 `data: 'data:image/png;base64,iVBORw0…'` 被 AI SDK 透传给 Anthropic API 的 `data` 字段，Anthropic 期望 raw base64，所以**即使换 M3 也会收不到图**。
3. **AFTER 截图 compositor 还没合成 overlay**：`cdp.highlightQuad` 异步提交到 Chrome compositor，cdp.ts 立刻调 `captureVisibleTab`，framebuffer 还没包含 overlay。AFTER 图 = BEFORE 图，LLM 没有 visual feedback，只能瞎调。

修复 1+2 已落地（默认改 M3 + `stripDataUrlPrefix`）。修复 3 还在调研中（任务 #21），需要 `Overlay.forceCompositingMode` 或简单的 200ms wait。

---

## 实验 #1 — 确认 M2.7 不收图

**目的**：验证 M2.7 是否真的不接受 image 输入。

**做法**：读 https://platform.minimaxi.com/docs/api-reference/text-anthropic-api 文档。

**结论**：
> `MiniMax-M3` 支持文本、图片、视频、工具调用、工具结果和 thinking 内容块。M2.7、M2.5、M2.1 和 M2 系列**仅支持文本与工具调用相关内容块，不支持图片和视频输入**。

**含义**：之前 32-visual-servoing 跑出来 LLM "收敛到 (650, 360)" 不是视觉推理，是猜一个看起来合理的位置。

---

## 实验 #2 — 确认 AI SDK 数据格式问题

**目的**：验证 `experimental_toToolResultContent` 透传的 image 格式 Anthropic 能不能解码。

**做法**：读 `node_modules/@ai-sdk/anthropic/dist/index.js:285-294`：

```javascript
case "image":
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: (_a2 = part2.mimeType) != null ? _a2 : "image/jpeg",
      data: part2.data           // ← 直接透传
    },
  };
```

`part2.data` 是 `ToolResultContent` 里 image 对象的 `data` 字段。cdpAim 当时传的是 `dataUrl`（带 `data:image/png;base64,` 前缀），Anthropic 期望 raw base64。

**结论**：前缀必须剥。新加 `stripDataUrlPrefix()` helper，应用到 `screenshot` / `cdpScreenshot` / `cdpAim` 三个工具。

---

## 实验 #3 — 独立 smoke test 验证 M3 收图

**目的**：确认 M3 + 修过前缀后真的能收到图。

**做法**：`scripts/m3-smoke.ts` — 构造 32x32 PNG 中心红方块，问"中间方块是什么颜色"。

**结果**：
```
--- response ---
The small square in the center of the image is red.
--- usage ---
{ "promptTokens": 106, "completionTokens": 12, "totalTokens": 118 }
```

106 prompt tokens = 图按 token 计费 = **图真的送进去了**。M2.7 时代这张图会被静默丢弃。

---

## 实验 #4 — 专用静态测试页（解决 UI 干扰）

**目的**：Bing/百度页面有红色 UI 元素（新闻卡、热搜列表）让 analyzer 误抓。需要一个**只有 crosshair 是红色**的页面。

**位置**：`e2e/probe-test-page/index.html`
- 1280×800 CSS 视口
- 4 个黑色角标（不是红色，避免干扰）
- 1 个 200×200 绿色 target @ CSS (540, 300) → (740, 500)，中心 (640, 400)
- 灰色 gridlines 每 100px，标了坐标
- 无 scroll、无 JS、无图片背景

**dev server**：`python -m http.server 8888 --directory e2e/probe-test-page`（后台跑）

---

## 实验 #5 — 33-overlay-probe (raw CDP, 无 LLM)

**目的**：在静态页上单独测试 `Overlay.highlightQuad` 协议本身能不能正确画框，给后面定位"bug 在哪一层"做基线。

**做法**：新增 `__e2e:overlay-probe` handler (`entrypoints/background.ts`)，5 个已知 CSS 点（(0,0) (100,100) (200,200) (400,400) (800,400)），fixed size=100，每次画 + 200ms wait + 截图，返回 tabInfo + Page.getLayoutMetrics + screenshots。

**结论**（视觉直接读 gridlines）：
- (0, 0)：✓ 正确（只有 BR 象限可见）
- (100, 100)：✓ 正确
- (200, 200)：✓ 正确
- **(400, 400)**：**✗ 飘到右下角** (~+700, +350 CSS)
- **(800, 400)**：**✗ 截图里完全看不到 crosshair**

第 4、第 5 个点 → 33 阶段诊断显示 cdpAim/Overlay 路径有渲染或截图 bug，但当时还**没和 LLM 行为联系上**。下一轮用 LLM 跑才发现是 rendering race（实验 #6）。

---

## 实验 #6 — 34-llm-aim-static-page (LLM 真在用图了，但发了盲)

**目的**：把 LLM 接到静态页，看 M3 + 图修之后能不能真的做 visual servoing。

**做法**：`e2e/specs/34-llm-aim-static-page.spec.ts` — LLM 看到 prompt "aim at the green target at CSS (640, 400)"，调用 cdpAim 迭代。

**关键 LLM 推理**（从 SW log 抓的）：
> [step 3] aim(x=640, y=400, size=200)  offset: (+0, +0)
> LLM: I can see the page. Screenshot is 1283x822 device pixels at what
>      appears to be dpr ≈ 1 (or close). The viewport is 1280x800 CSS px,
>      and the green target is at CSS (540, 300) to (740, 500), center (640, 400).
>      Let me start PHASE 1 by aiming size=200 at the known center.

**第一次瞄准零误差**——LLM 真的看到图、找到绿色 target、算出 (640, 400) 中心、传对了。

**但后续迭代越来越偏**（640, 400 → 640, 400 → 640, 400 → 0, 0 → 640, 400）。LLM 自己在 step 9 说：

> "Wait — I need to reconsider. Looking at the first aim result's AFTER
> image carefully: it's identical to the BEFORE image. **No visible
> crosshair.** Yet the tool reports it drew one."
>
> "For the second aim (size=100), the AFTER image DID show a red
> [crosshair]..."

**这是 #21 (rendering race) 的 smoking gun。** LLM 在盲调。

---

## 实验 #7 — 直接看 5 张 AFTER 截图确认渲染问题

**截图清单**（`.e2e-logs/34-aim-*.png`）：

| file | size (bytes) | 大小差异 | 视觉结论 |
|---|---|---|---|
| `34-aim-00-x640y400s200.png` | 68177 | 基线 | **❌ 完全没有红框** |
| `34-aim-01-x640y400s100.png` | 69301 | +1124 | ✓ 有红框，但**飘到右下角** (css ~1090, 693)，LLM 要求 (640, 400) |
| `34-aim-02-x640y400s200.png` | 68177 | 0（同 00） | ❌ 没有红框 |
| `34-aim-03-x0y0s80.png` | 68177 | 0（同 00） | ❌ 没有红框 |
| `34-aim-04-x640y400s200.png` | 68177 | 0（同 00） | ❌ 没有红框 |

**4/5 截图里 AFTER == BEFORE**。LLM 没拿到任何视觉反馈。

**`33-overlay-probe` handler 每次 `highlightQuad` 后等了 200ms**（`entrypoints/background.ts:478`）——但 cdp.ts 里的 cdpAim **没等**：

```javascript
// lib/cdp.ts:224-229 — 没 wait
await cdp.highlightQuad(x, y, size, color);
const after = await cdp.screenshot();
```

```javascript
// entrypoints/background.ts:478-486 — 33-probe handler，有 200ms wait
await new Promise((r) => setTimeout(r, 200));
const dataUrl = await chrome.tabs.captureVisibleTab(...);
```

`Overlay.highlightQuad` 是异步协议：CDP 层立即返回，但 GPU compositor 还没把 overlay 画到 framebuffer。如果立即 capture，framebuffer 不含 overlay → AFTER = BEFORE。

---

## 实验 #8 — 文件大小差异做交叉验证

`.e2e-logs/34-aim-00` 和 `34-aim-02/03/04` 完全相同（68177 bytes）= 4 张完全一样的截图 = 4 次 cdpAim **都返回了不带 overlay 的截图**。这从 PNG 字节级别证实了渲染问题。

---

## 待办

- **#19**：把 dpr 换算从 LLM 移到工具（让 LLM 只用截图 px 思考）
- **#21**：给 `cdp.screenshot()` 加 compositor wait（200ms 或 `Overlay.forceCompositingMode`），或换一种更可靠的捕获方式
- 两个一起做完后，重跑 34 测试，断言 5/5 截图都看到红框 + 红框位置合理
- 32-visual-servoing prompt 里"divide by dpr"等 dpr 措辞清理（dpr 抽取落地后）
