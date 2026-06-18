// Surgical replacement of the cdpAim block in lib/tools.ts.
// Old = CSS-px coordinates (LLM had to divide by dpr).
// New = screenshot-px coordinates (tool converts internally using cdp.dpr).
const fs = require('fs');
const path = 'D:/Projects/BrowserAI/lib/tools.ts';
let src = fs.readFileSync(path, 'utf8');

const startMarker = 'export const cdpAim = tool({';
const endMarker = 'export const cdpConfirm = tool({');
const i0 = src.indexOf(startMarker);
const i1 = src.indexOf(endMarker);
if (i0 < 0 || i1 < 0) { console.error('markers not found'); process.exit(1); }

const newCdpAim = `export const cdpAim = tool({
  description:
    'Draw a colored highlight square (crosshair) at SCREENSHOT coordinates (x, y) using CDP Overlay, then take a screenshot so you can visually verify the position BEFORE clicking. The x, y, size parameters are in the SAME coordinate space as the BEFORE/AFTER images you see (screenshot pixel coordinates) — the tool converts to CSS internamente using the cached dpr. You do NOT need to think about dpr. This tool AUTOMATICALLY captures a BEFORE screenshot (no crosshair) AND an AFTER screenshot (with crosshair drawn) so you can compare them and decide if the position is correct. If the crosshair is ON target, call cdpConfirm(x, y) with the SAME coordinates. If NOT, call cdpCancel() then call cdpAim again with corrected SCREENSHOT coordinates. MANDATORY verification loop: aim -> compare before/after -> if off-target, cancel and re-aim -> repeat until on target, THEN cdpConfirm. Do NOT call cdpClick directly — always use the aim->confirm flow.\\n\\nVISUAL SERVOING — two phases, separate position from size:\\n  Phase 1 (FIX POSITION, size locked at 200): aim with a large box. Compare BEFORE/AFTER. If target is inside the red box, advance. If off-target, cancel and re-aim with corrected x/y. Keep size=200. Iterate 3-4 rounds until the target is centered.\\n  Phase 2 (SHRINK SIZE, position locked): once centered, shrink the box: 200->100->50->20. Verify the target is still fully covered at each size.\\n  CRITICAL: never change BOTH x/y and size in the same step. Phase 1 changes only x/y. Phase 2 changes only size. Mixing them makes the visual feedback ambiguous.\\n\\nCOLOR: pick a color that CONTRASTS with the page background (e.g., red on white, cyan/yellow on dark pages, green on red pages). Defaults to red. CSS names (red/blue/lime/cyan/yellow/magenta/orange/purple/white/black) or #rrggbb.',
  parameters: z.object({
    x: z.number().int().min(0).describe('SCREENSHOT X coordinate to aim at (the same units as the BEFORE/AFTER image you see)'),
    y: z.number().int().min(0).describe('SCREENSHOT Y coordinate to aim at (the same units as the BEFORE/AFTER image you see)'),
    size: z.number().int().min(8).max(400).default(80).describe('Side length of the highlight square in SCREENSHOT pixels. DEFAULT 80 — must be large enough to see (8px is invisible on HiDPI).'),
    color: z.string().default('red').describe('CSS color name (red/blue/lime/cyan/yellow/orange/purple/white/black) or #rrggbb. Pick a color contrasting the page background.'),
  }),
  execute: async ({ x, y, size, color }) => {
    const cdp = getCurrentCDP();
    if (!cdp) throw new Error('CDP not available');
    const tab = await getActiveTab();
    await cdp.attach(tab.id);
    // Pre-screenshot BEFORE drawing the crosshair so the LLM can compare
    // before/after and verify the crosshair actually landed where it asked.
    const before = await cdp.screenshot();
    // x, y, size arrive in SCREENSHOT pixels (what the LLM sees in the
    // image). Convert to CSS pixels using the cached dpr from the previous
    // screenshot() call — the LLM never has to think about dpr, DPR, or
    // any device-vs-CSS distinction.
    const dpr = cdp.dpr;
    const cssX = Math.round(x / dpr);
    const cssY = Math.round(y / dpr);
    const cssSize = Math.round(size / dpr);
    await cdp.highlightQuad(cssX, cssY, cssSize, color);
    const after = await cdp.screenshot();
    return {
      dataUrl: after.dataUrl,
      beforeDataUrl: before.dataUrl,
      // Report the screenshot dimensions so the LLM knows the coordinate
      // space it should keep using. dpr and CSS dimensions are kept for
      // debugging but the LLM is no longer expected to divide by dpr.
      width: tab.width ?? 0,
      height: tab.height ?? 0,
      screenshotWidth: after.width,
      screenshotHeight: after.height,
      dpr,
      aimX: x,                           // screenshot px (matches the caller's intent)
      aimY: y,
      color,
    };
  },
  experimental_toToolResultContent: (output: {
    dataUrl: string; beforeDataUrl?: string;
    width: number; height: number; dpr: number;
    aimX: number; aimY: number;
  }) => {
    const text = [
      \`AIMED at SCREENSHOT pixel (\${output.aimX}, \${output.aimY}) on a \${output.screenshotWidth}x\${output.screenshotHeight} image.\`,
      \`The tool converted your screenshot coordinates to CSS internamente — no dpr math needed.\`,
      \`COMPARE the BEFORE and AFTER images: is the red square on your target? If YES -> cdpConfirm(\${output.aimX}, \${output.aimY}). If NO -> cdpCancel() + cdpAim with corrected SCREENSHOT coordinates.\`,
      \`Always pass the same coordinate space as the image (screenshot pixels).\`,
    ].join(' ');
    const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
      { type: 'text', text },
    ];
    if (output.beforeDataUrl) {
      content.push({ type: 'text', text: 'BEFORE (no crosshair):' });
      content.push({ type: 'image', data: stripDataUrlPrefix(output.beforeDataUrl), mimeType: 'image/png' });
    }
    content.push({ type: 'text', text: \`AFTER (red crosshair at SCREENSHOT \${output.aimX}, \${output.aimY}):\` });
    content.push({ type: 'image', data: stripDataUrlPrefix(output.dataUrl), mimeType: 'image/png' });
    return content;
  },
});

`;

src = src.slice(0, i0) + newCdpAim + src.slice(i1);
fs.writeFileSync(path, src);
console.log(`patched ${i1 - i0} bytes in lib/tools.ts`);
