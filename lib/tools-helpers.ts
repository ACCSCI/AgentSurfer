// Shared helpers used by AI SDK tools that need to run JS in the active
// page. All tools share these so the boilerplate stays in one place.

export interface ActiveTab {
  id: number;
  windowId: number;
  url: string | undefined;
  title: string | undefined;
  width: number | undefined;
  height: number | undefined;
}

export async function getActiveTab(): Promise<ActiveTab> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  return {
    id: tab.id,
    windowId: tab.windowId ?? 0,
    url: tab.url,
    title: tab.title,
    width: tab.width,
    height: tab.height,
  };
}

export async function runOnActiveTab<T>(func: () => T | Promise<T>): Promise<T> {
  const tab = await getActiveTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: func as () => T,
  });
  if (!result) throw new Error('executeScript returned no result');
  return result.result as T;
}
