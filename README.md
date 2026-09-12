# ChatGPT Web Agent

A browser-first Chrome agent that uses the user's existing logged-in `chatgpt.com` session as the reasoning engine.

**Current Chrome extension: v0.11.0.**

No OpenAI API key is required for the Side Panel browser-session workflow.

> This project approximates a first-party browser agent, but it is not a native OpenAI browser-tool integration. The ChatGPT bridge depends on the `chatgpt.com` web UI and may need selector updates when that UI changes.

## v0.11 — Hybrid Vision + DOM + virtual CDP

The runtime no longer treats DOM as the mandatory first step.

```text
User task
   ↓
Screenshot-first LOOK
   ↓
ChatGPT vision
   ↓
choose fastest action path
   ├─ Semantic DOM/accessibility when available
   └─ Virtual CDP coordinates for canvas/custom UI
   ↓
local action batch
   ↓
fresh screenshot verification
   ↓
repeat only when another model decision is needed
```

The core principle is:

```text
SEE with Vision
ACT with DOM or virtual CDP
VERIFY with Vision
```

This works well across normal websites, WordPress/admin forms, Elementor, Figma, canvas/WebGL apps, maps and other interfaces where DOM selectors alone are unreliable.

## Why hybrid

### DOM/accessibility path

Fastest and most precise when the page exposes useful controls:

```text
page.find
page.clickText
page.typeByLabel
page.selectOption
page.check
```

### Vision/CDP path

Fallback for canvas, custom renderers and hard-to-select UI:

```text
page.look      screenshot + tab metadata
page.click     x/y virtual click
page.typeAt    x/y virtual click + CDP text input
page.drag      virtual drag
page.scroll
page.hotkey
```

Virtual CDP input is delivered directly to Chrome. It does **not** move the user's Windows mouse pointer and does **not** take over the physical keyboard.

## Performance model

v0.11 reduces ChatGPT round-trips in two ways:

1. the initial context is screenshot-first instead of a large DOM/accessibility dump;
2. ChatGPT can return a small deterministic `batch` of browser actions, which the extension executes locally before asking the model again.

The agent is instructed to use a batch only when it does not need to see an intermediate result first.

Typical flow:

```text
Screenshot
  ↓
ChatGPT decides:
  1. click heading
  2. Ctrl+A
  3. type text
  ↓
Extension executes locally
  ↓
Fresh screenshot
  ↓
ChatGPT verifies
```

## Tab Group sandbox

Each workspace is a real Chrome Tab Group named **ChatGPT Agent**.

- the agent can only inspect or operate tabs in the active group;
- new websites opened by the agent join the same group;
- the ChatGPT reasoning tab stays outside the group;
- tool calls targeting tabs outside the group fail;
- the Side Panel is scoped to the agent group and closes when the user switches to a tab outside the group.

This restriction is enforced by extension code, not just by prompt instructions.

## No OS mouse/keyboard takeover

The agent does not use PyAutoGUI, AutoHotkey, Windows `SetCursorPos`, or OS-level keyboard injection.

Input is handled by:

```text
DOM events/setters
or
Chrome DevTools Protocol Input.* events
```

So the user can keep using the physical mouse and keyboard while the agent operates browser tabs.

## Permission modes

The Side Panel supports:

```text
Automatically approve
Ask before actions
Read only
```

Sensitive actions such as delete, publish, send, checkout/payment, account destruction, logout/revoke and other high-risk operations require explicit approval even in automatic mode.

## ChatGPT streaming and model picker

The Side Panel mirrors the selected ChatGPT conversation and streams assistant output while ChatGPT is generating.

The model selector is discovered from the real `chatgpt.com` model picker for the user's account rather than from a hard-coded model list.

## Main browser tools

### Screenshot / visual

```text
page.look
page.screenshot
page.viewport.get
page.viewport.set
page.viewport.clear
```

### Semantic / DOM

```text
page.peekDom
page.read
page.accessibility
page.find
page.inspect
page.elements
page.elementAt
page.clickText
page.typeByLabel
page.focus
page.selectOption
page.check
```

### Virtual input

```text
page.click
page.doubleClick
page.rightClick
page.hover
page.typeAt
page.type
page.key
page.hotkey
page.scroll
page.drag
page.upload
```

### Tabs/navigation

```text
tabs.list
tabs.open
tabs.switch
tabs.close

tab.active
tab.navigate
tab.reload
tab.back
tab.forward
```

## Runtime limits

Current defaults:

```text
maximum model rounds: 14
maximum browser actions: 40
maximum actions per local batch: 6
maximum task runtime: 10 minutes
approval timeout: 2 minutes
```

## Chrome extension structure

```text
chrome-extension/
├── manifest.json
├── service-worker-entry.js
├── service-worker.js
├── hybrid-agent-runtime.js
├── agent-tools.js
├── agent-policy.js
├── local-browser-tools.js
├── group-scoped-tools.js
├── tab-group-session.js
├── sidepanel-scope.js
├── chatgpt-content.js
├── chatgpt-live-bridge.js
├── stream-model-bridge.js
├── stream-model-ui.js
├── sidepanel.html
├── sidepanel.css
├── agent.css
├── sidepanel.js
├── group-ui.js
├── permission-ui.js
├── options.html
└── options.js
```

## Quick start

### 1. Update the repository

```bash
cd ~/projects/chatgpt-web-agent
git pull origin main
```

### 2. Optional WSL backend

```bash
cd server
npm install
npm start
```

The Side Panel agent logic runs mainly inside the Chrome extension. The WSL backend remains useful for persistence, remote control, visual comparison and future integrations.

### 3. Reload the extension

Open:

```text
chrome://extensions
```

Reload **ChatGPT Web Agent** and confirm version `0.11.0`.

### 4. Open ChatGPT

Keep at least one logged-in `https://chatgpt.com/` tab open.

### 5. Start a workspace

Open the website you want to work on and click the extension icon. That website becomes the seed of the **ChatGPT Agent** tab group.

Example task:

```text
Look at the Figma design in this group, then rebuild the hero in Elementor.
Use DOM controls when reliable and visual/CDP actions when the editor is canvas-like.
Verify the frontend visually before finishing.
```

## Security notes

- ChatGPT cookies/session tokens stay inside Chrome.
- Password field values are redacted from safe observations.
- Page content is treated as untrusted data.
- The agent cannot intentionally target tabs outside the active agent group.
- High-risk state-changing operations require approval.
- The runtime does not need OpenAI API keys for the normal Side Panel workflow.
