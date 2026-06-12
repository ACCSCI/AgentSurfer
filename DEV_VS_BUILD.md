# Dev mode vs Build — IMPORTANT

## Always use `bun run build` for loading the extension into Chrome

**`bun run dev` produces a 2.78 MB Service Worker** (with WXT's HMR / live-reload runtime embedded). Chrome's MV3 SW registration is unreliable with such large bundles, and the SW shows as **"Invalid"** in `chrome://extensions/`. The side panel won't open.

`bun run build` produces a **350 KB Service Worker** that works reliably. The e2e suite is verified to pass against this build.

## Steps to load the extension

1. `bun run build`
2. Open `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked" and pick `D:\Projects\BrowserAI\.output\chrome-mv3`  ← **NOT** `chrome-mv3-dev`
5. Confirm "Service Worker" status is **valid** (clickable link, not "无效")
6. Click the extension icon to open the side panel

## When to use dev

Use `bun run dev` only when you specifically need HMR for UI iteration, AND you're prepared for SW registration flakiness. Otherwise, prefer the build.

## Why this happens

WXT 0.20.x bundles a reload-runtime into the SW for dev mode. This inflates the SW from ~350 KB to ~2.78 MB. Chrome can register large SWs but the registration is often flagged as invalid on certain Chrome versions / Windows configurations.
