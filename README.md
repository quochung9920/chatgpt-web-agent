# ChatGPT Web Agent

A browser-first agent that uses the user's existing logged-in `chatgpt.com` session as the reasoning engine while a Chrome extension observes and operates the user's real browser.

**Current Chrome extension: v0.9.0.**

No OpenAI API key is required for Side Panel browser-session mode.

> This project can approximate the workflow and UX of first-party browser agents, but it is not a first-party OpenAI browser tool integration. The ChatGPT bridge depends on the `chatgpt.com` web UI and may need selector updates when that UI changes.

## v0.9 architecture

```text
Windows Chrome
┌──────────────────────────────────────────────────────────┐
│                                                         │
│  ╭──────────── ChatGPT Agent tab group ──────────────╮  │
│  │ Elementor │ Figma │ Frontend │ wp-admin │ ...    │  │
│  ╰────────────────────────────────────────────────────╯  │
│                                            Side Panel    │
│                                    ┌───────────────────┐  │
│                                    │ ChatGPT Web Agent │  │
│                                    │ observe           │  │
│                                    │ decide            │  │
│                                    │ act               │  │
│                                    │ verify            │  │
│                                    └───────────────────┘  │
│                                                         │
│  chatgpt.com reasoning tab (outside the agent group)    │
└──────────────────────────────────────────────────────────┘
                         │
                         └─ optional WSL Web Agent backend
```

The ChatGPT login/session stays inside Chrome. The extension does not export ChatGPT cookies or session tokens to WSL.

## Agent loop

v0.9 uses an observe-act-verify loop instead of a blind command loop:

```text
User task
  ↓
Initial observation
  ├─ safe DOM/page text
  ├─ interactive elements
  ├─ accessibility snapshot
  └─ screenshot → ChatGPT vision
  ↓
ChatGPT decision
  ↓
Browser action
  ↓
Automatic post-action observation
  ↓
ChatGPT verifies result
  ↓
repeat until complete
```

The agent receives browser context automatically, so it should not ask the user to paste a URL or manually provide a screenshot when the page is already inside the active agent group.

## Tab Group sandbox

Each agent workspace is one real Chrome Tab Group named **ChatGPT Agent**.

- opening the Side Panel on a website can make that tab the session seed;
- the agent can only inspect and operate website tabs in the active group;
- `tabs.open` creates new websites inside the same group;
- tabs opened from a group tab are automatically captured into the group when possible;
- the ChatGPT reasoning tab stays outside the group;
- tool calls targeting a tab outside the group fail with `tab_outside_agent_group`.

This restriction is enforced by the extension, not only by prompting the model.

## Permission modes

The Side Panel supports three modes:

```text
Automatically approve
Ask before actions
Read only
```

Even in **Automatically approve**, sensitive actions are intercepted and require explicit user approval when the agent detects targets/intents such as:

- delete/remove/account destruction;
- publish;
- send/submit;
- purchases/checkout/payment/transfers;
- passwords/passcodes;
- logout/revoke/disconnect;
- closing tabs.

The panel shows an approval card with **Deny** and **Allow once**.

## Prompt-injection and secret safeguards

Webpage content is treated as untrusted data in the agent system context.

The runtime instructs ChatGPT not to obey page content that tries to override the user task, reveal secrets, leave the active group, or change agent policy.

Password input values are redacted from safe observations and accessibility snapshots.

## Browser capabilities

Core navigation and page control:

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

page.wait
page.read
page.accessibility
page.inspect
page.elements
page.elementAt
page.screenshot

page.click
page.doubleClick
page.rightClick
page.hover
page.type
page.key
page.scroll
page.drag

page.viewport.get
page.viewport.set
page.viewport.clear
```

v0.9 semantic/agent tools:

```text
page.observe        combined safe DOM + accessibility + screenshot
page.find           semantic element search
page.clickText      click by visible text/role
page.typeByLabel    type by label/aria-label/placeholder
page.focus           focus an element semantically or by selector
page.selectOption    select native options
page.check           set checkbox/radio state
page.hotkey          CDP keyboard shortcuts
page.upload          upload supplied task data to file inputs
```

For complex visual apps such as Elementor and Figma, the agent can combine semantic DOM/accessibility tools with screenshots and coordinate-based mouse/drag controls.

## Side Panel

The Side Panel provides:

- server and ChatGPT connection state;
- current working website;
- current Chrome agent group and tab count;
- permission mode selector;
- ChatGPT conversation selection;
- activity timeline;
- Stop button;
- sensitive-action approval cards;
- direct task input.

Example task:

```text
Open the Figma tab in this group, inspect the PawCare hero,
then switch to Elementor and rebuild the hero to match it.
Verify desktop and mobile before finishing.
```

## Runtime limits

To prevent accidental infinite loops, a task currently has:

```text
maximum browser steps: 40
maximum runtime: 10 minutes
approval timeout: 2 minutes
```

The latest task state is persisted in extension storage for diagnostics.

## Chrome extension structure

```text
chrome-extension/
├── manifest.json
├── service-worker.js
├── background.js
├── agent-tools.js
├── agent-policy.js
├── local-browser-tools.js
├── group-scoped-tools.js
├── tab-group-session.js
├── chatgpt-content.js
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

### 1. Run the optional WSL server

```bash
cd ~/projects/chatgpt-web-agent/server
npm install
npm start
```

Local extension configuration:

```text
Server URL: ws://localhost:8787
Agent ID: desktop-chrome
Agent Token: same AGENT_TOKEN as server/.env
```

### 2. Load the extension

Open:

```text
chrome://extensions
```

Enable Developer Mode, choose **Load unpacked**, and select `chrome-extension/`.

After pulling a new version, press **Reload** on the extension card.

### 3. Keep ChatGPT logged in

Open at least one logged-in:

```text
https://chatgpt.com/
```

The reasoning conversation stays in that tab while the website and Side Panel remain visible.

### 4. Open the Side Panel on the website you want to control

Click the ChatGPT Web Agent extension icon.

The website becomes part of the orange **ChatGPT Agent** group. Use **Use current tab** when you intentionally want to switch the agent to another workspace.

### 5. Choose a permission mode and give the agent a task

Recommended for normal development work:

```text
Automatically approve
```

Sensitive operations still require manual approval.

## Example verification workflow

```text
Figma reference tab
  ↓ observe + screenshot
Elementor editor tab
  ↓ inspect / click / type / drag
Frontend tab
  ↓ screenshot + DOM observation
Desktop / tablet / mobile
  ↓ verify
Mismatch
  ↓ return to editor and repair
DONE
```

## What is not first-party parity

This project cannot attach native browser tools directly to the model running a normal ChatGPT web conversation. The extension therefore bridges browser observations/tool results through the logged-in ChatGPT web UI.

Consequences:

- ChatGPT web DOM changes can break the bridge;
- screenshot attachment depends on the current ChatGPT composer UI;
- some cross-origin iframe, closed Shadow DOM, canvas-only or browser-native UI interactions can require coordinate fallback or remain inaccessible;
- `chrome://` pages and Chrome toolbar/native dialogs are not ordinary website targets.

## Optional Custom GPT + OAuth mode

The repository still contains:

```text
chatgpt-action/openapi.yaml
chatgpt-action/instructions.md
docs/SETUP.md
```

for users who prefer an official Custom GPT Action/OAuth path instead of the browser-session bridge.

## Version

`0.9.0` — tab-group sandbox + automatic observation + semantic tools + screenshot vision + permission/risk policy + observe-act-verify agent loop.
