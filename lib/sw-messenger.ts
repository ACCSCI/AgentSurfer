// Shared helper: send a message to the SW and await the response.
// Uses the Promise+callback pattern which is reliable in MV3.

export async function sendToSW(message: { type: string; [k: string]: unknown }): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response as { ok: boolean; data?: unknown; error?: string });
      }
    });
  });
}
