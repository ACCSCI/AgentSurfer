import { defineConfig } from 'wxt';
import { fileURLToPath, URL } from 'node:url';

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: '.',
  outDir: '.output',

  // The manifest is fully type-safe.
  // https://wxt.dev/guide/manifest.html
  manifest: () => ({
    name: 'AgentSurfer',
    short_name: 'AgentSurfer',
    description:
      'AI-powered browser agent: control any page with natural language across 6 LLM providers.',
    permissions: ['tabs', 'scripting', 'storage', 'sidePanel'],
    host_permissions: ['<all_urls>'],
    action: {},
    side_panel: {
      default_path: 'sidepanel.html',
    },
    icons: {
      '16': 'icon/16.png',
      '32': 'icon/32.png',
      '48': 'icon/48.png',
      '128': 'icon/128.png',
    },
    // MV3 requires every file the extension loads (side panel HTML/JS/CSS
    // chunks) to be explicitly web-accessible, or the side panel will
    // 404 on its own assets and Chrome will mark the SW "Invalid".
    web_accessible_resources: [
      {
        resources: ['sidepanel.html', 'options.html', 'icon/*', 'content-scripts/*'],
        matches: ['<all_urls>'],
      },
    ],
  }),

  modules: ['@wxt-dev/module-react'],

  vite: () => ({
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./', import.meta.url)),
      },
    },
  }),
});
