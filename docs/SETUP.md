# Setup guide — ChatGPT Web Agent v0.11

The primary workflow is the Chrome Side Panel using the user's existing logged-in `chatgpt.com` session.

The v0.11 runtime is hybrid:

```text
Screenshot/Vision first
  ↓
DOM/accessibility when useful
  ↓
Virtual CDP input when DOM is unreliable
  ↓
Screenshot verification
```

It does not use the user's physical Windows mouse or keyboard.

## 1. Update the repository

```bash
cd ~/projects/chatgpt-web-agent
git pull origin main
```

## 2. Run the optional WSL backend

```bash
cd ~/projects/chatgpt-web-agent/server
npm install
npm start
```

Check:

```bash
curl http://localhost:8787/health
```

The Chrome extension can perform the local browser-agent loop without routing every click through WSL. The backend remains useful for persistence, comparison and remote integrations.

## 3. Load/reload the Chrome extension

Open:

```text
chrome://extensions
```

Enable Developer mode, load the `chrome-extension` folder if necessary, then click **Reload**.

Confirm:

```text
ChatGPT Web Agent
Version 0.11.0
```

## 4. Configure the extension

Extension options:

```text
Server URL: ws://localhost:8787
Agent ID: desktop-chrome
Agent token: same AGENT_TOKEN as server/.env
```

The Agent Token secures the optional extension↔WSL connection. It is not an OpenAI API key.

## 5. Keep ChatGPT logged in

Open at least one normal tab at:

```text
https://chatgpt.com/
```

The extension uses that existing web session as the reasoning engine. It does not export ChatGPT cookies/session tokens to WSL.

## 6. Start a browser-agent workspace

Open the website you want to work on and click the ChatGPT Web Agent extension icon.

The extension creates/activates a real Chrome Tab Group:

```text
ChatGPT Agent
```

Only website tabs in that group are valid work targets.

The Side Panel is tab-group scoped. Switching to a tab outside the group closes the agent panel for that tab.

## 7. Hybrid interaction behavior

### Normal controls

The agent prefers semantic DOM/accessibility actions when controls can be found reliably:

```text
page.find
page.clickText
page.typeByLabel
page.selectOption
page.check
```

### Figma/canvas/custom editors

When DOM is incomplete or useless, the agent uses screenshot vision plus virtual CDP coordinates:

```text
page.look
page.click {x,y}
page.typeAt {x,y,text}
page.drag
page.scroll
page.hotkey
```

The coordinates are sent to Chrome through DevTools Protocol. The physical mouse cursor does not move.

## 8. Local batching for speed

ChatGPT may return up to six deterministic browser actions in one batch. The extension executes them locally and then sends a fresh screenshot back for verification.

This reduces the old pattern:

```text
ChatGPT → click → ChatGPT → type → ChatGPT → click
```

into:

```text
ChatGPT → [click, type, click] → screenshot → ChatGPT verify
```

The runtime should not batch actions when an intermediate screenshot is needed to safely decide the next step.

## 9. Permission modes

The panel exposes:

```text
Automatically approve
Ask before actions
Read only
```

High-risk actions still require confirmation, including operations such as publish, delete, send, checkout/payment, destructive account actions and logout/revoke.

## 10. Streaming and model selection

The Side Panel streams ChatGPT output while the selected ChatGPT tab is generating.

The model dropdown is discovered from the real ChatGPT model picker, so it reflects what the logged-in account currently exposes rather than a hard-coded list.

## 11. Suggested tests

### Visual question

```text
What website/app is open and what do you see on screen?
```

Expected: screenshot-first answer without a large DOM bootstrap.

### Semantic DOM

```text
Find the Search field and type test, but do not submit.
```

Expected: semantic field discovery and DOM typing when available.

### Canvas/custom UI

```text
Click the visible Share control in this Figma tab.
```

Expected: vision/coordinate fallback if DOM discovery is not useful.

### Multi-tab workflow

```text
Inspect the Figma hero, switch to Elementor, rebuild it, then open the frontend and verify the result visually.
```

Expected: all work remains inside the ChatGPT Agent tab group.

## 12. Troubleshooting

### ChatGPT not ready

Reload the `chatgpt.com` tab, then click **Refresh** or **Sync ChatGPT** in the Side Panel.

### Model unavailable

The ChatGPT web model picker could not be detected or the current account/conversation does not expose another selectable model. Open the ChatGPT tab and verify the picker manually.

### Agent cannot click a control

The hybrid runtime should automatically choose between semantic DOM and screenshot/CDP. If a site uses unusual nested canvases or cross-origin UI, ask the agent to take a fresh screenshot and use visual coordinates.

### Side Panel appears outside the agent group

Reload extension v0.11.0 from `chrome://extensions`. The current runtime disables the global panel and scopes it per group tab.

## Security summary

```text
Tab Group sandbox             enabled
OS mouse takeover             not used
OS keyboard takeover          not used
ChatGPT cookie export         not used
Password observation          redacted
High-risk approvals           enabled
Webpage prompt injection      treated as untrusted data
```
