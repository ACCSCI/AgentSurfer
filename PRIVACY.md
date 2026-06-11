# AgentSurfer — Privacy Policy

_Last updated: 2026-06-11_

AgentSurfer ("we", "the extension") is a Chrome extension that lets you control
the active browser tab with natural-language instructions, using a large
language model (LLM) of your choice. This page explains what data the
extension handles, where it goes, and what stays on your device.

## Short version

- **Your API keys and chat history never leave your machine** except to call
  the LLM provider you configured.
- **We do not run a backend server.** There is no AgentSurfer-hosted service
  that sees your prompts, screenshots, or page content.
- **We collect no analytics, no telemetry, no crash reports.**

## What stays on your device

The following data is stored in your browser's IndexedDB (via Dexie.js) and
never transmitted to anyone except the LLM provider you chose:

- The API keys you enter in the options page.
- Your chat history: messages, agent steps, tool calls, and tool results.
- Screenshots of the active tab captured during agent runs.
- Your preferences: which model is the default, theme, etc.

You can wipe all of this at any time by clearing the extension's storage from
`chrome://extensions` → AgentSurfer → "Remove".

## What is sent off-device, and to whom

While an agent run is in progress, the extension sends the following to the
LLM provider you selected in the options page (OpenAI, Anthropic, your custom
OpenAI-compatible endpoint, Xiaomi MiMo, or MiniMax):

- The text of your prompt.
- A screenshot of the active tab (PNG) when the agent calls the `screenshot`
  tool. This happens by default before any action the agent takes, so the
  model can see what you see.
- The text content of elements matched by the agent's `domQuery` calls.
- The model's own previous tool calls and results, so it can chain actions.

This is the **only** data the extension transmits. There is no telemetry,
no analytics, no crash reporting, no background beacon, no remote-config
fetch, and no extension-update check beyond Chrome's normal update mechanism.

## Permissions, in plain English

The extension requests the following Chrome permissions, each for the reason
stated:

- **tabs** — to detect which tab is active and to read its URL and title.
- **scripting** — to run "look at the page" and "click the button" commands
  inside the active tab. The agent cannot act on a page without this.
- **storage** — to remember your preferences between sessions.
- **sidePanel** — to open the AgentSurfer chat UI next to the page.
- **host_permissions: `<all_urls>`** — the agent must work on the page you
  point it at, which can be any site. The user always initiates the action;
  the agent never visits a page on its own.

## Your responsibility

By using AgentSurfer you confirm that:

- You have the right to send the content of the pages you automate to the
  LLM provider you configured. Be careful with confidential documents and
  personal data.
- The agent may take unintended actions if the page changes. Always review
  the step trace in the side panel before letting the agent act on
  irreversible flows (purchases, deletions, sending messages).
- You will not use AgentSurfer to violate the terms of service of any
  website you automate.

## Children's privacy

AgentSurfer is not directed at children under 13 and we do not knowingly
collect any data from children.

## Changes to this policy

If we change what data the extension handles, we will update this page and
bump the "Last updated" date above. Material changes will also be noted in
the extension's release notes.

## Contact

Found a privacy issue? Open an issue at
https://github.com/ACCSCI/AgentSurfer/issues.
