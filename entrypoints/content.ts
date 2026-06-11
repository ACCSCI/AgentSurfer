// Content script: runs in ISOLATED world on every page.
// Used for persistent listeners and messaging with the active page.
// DOM tools (query/click/type) use chrome.scripting.executeScript({ func })
// directly — no pre-injection needed for those.

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    // Page-ready signal for the agent.
    document.addEventListener('readystatechange', () => {
      if (document.readyState === 'complete') {
        chrome.runtime.sendMessage({ type: 'content:ready', url: location.href }).catch(() => {
          // SW may be inactive; safe to ignore
        });
      }
    });
  },
});
