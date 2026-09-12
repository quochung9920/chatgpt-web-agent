# Setup guide — ChatGPT Web Agent v0.9

The primary workflow is now the Chrome Side Panel using the user's existing logged-in `chatgpt.com` session.

```text
Side Panel
  -> ChatGPT web session already logged in
  -> agent orchestrator
  -> Chrome Tab Group sandbox
  -> website UI
```

No OpenAI API key is required for this mode.

## 1. Requirements

- Windows Chrome/Chromium
- WSL2 is recommended for the optional control server
- Node.js 20+
- a normal logged-in `https://chatgpt.com/` tab in the same Chrome profile

WordPress, Elementor, Figma, Shopify, Webflow and other systems are operated through Chrome. No WordPress-specific plugin is required.

## 2. Update the repository

```bash
cd ~/projects/chatgpt-web-agent
git checkout main
git pull origin main
```

## 3. Start the optional WSL server

```bash
cd ~/projects/chatgpt-web-agent/server
npm install
npm start
```

For local Chrome usage:

```text
Server URL: ws://localhost:8787
Agent ID: desktop-chrome
Agent Token: value of AGENT_TOKEN in server/.env
```

Check it from WSL:

```bash
curl http://localhost:8787/health
```

and optionally from Windows PowerShell:

```powershell
curl.exe http://localhost:8787/health
```

The Side Panel agent loop runs locally in the extension. The WSL server remains useful for remote control, persistence, target/visual comparison and optional OAuth mode.

## 4. Install or reload the Chrome extension

Open:

```text
chrome://extensions
```

1. Enable **Developer mode**.
2. Choose **Load unpacked** for the first install.
3. Select `chrome-extension/`.
4. For later updates, press **Reload** on the extension card.
5. Confirm the extension version is `0.9.0`.

If the repository is inside WSL, open the extension directory in Windows Explorer with:

```bash
cd ~/projects/chatgpt-web-agent/chrome-extension
explorer.exe .
```

## 5. Configure the extension

Open the extension Options page and set:

```text
Server URL: ws://localhost:8787
Agent ID: desktop-chrome
Agent Token: <AGENT_TOKEN>
```

The Agent Token is a credential for your own Web Agent server. It is not an OpenAI API key and does not create OpenAI API usage charges.

## 6. Open ChatGPT

Keep at least one logged-in tab open:

```text
https://chatgpt.com/
```

The extension uses that tab as a reasoning conversation. ChatGPT cookies/session tokens remain inside Chrome and are not copied to WSL.

## 7. Start an agent workspace

Navigate to the website you want the agent to control and click the ChatGPT Web Agent extension icon.

The extension creates or activates a real Chrome Tab Group named:

```text
ChatGPT Agent
```

The active website becomes the seed tab.

The agent is hard-sandboxed to this group:

- it only receives group tabs in `tabs.list`;
- browser tools reject tab IDs outside the group;
- new tabs created by `tabs.open` join the group;
- links that open new tabs from a group website are captured into the group when possible;
- the ChatGPT reasoning tab stays outside the group.

Use **Use current tab** when you intentionally want to start a different browser workspace.

## 8. Permission modes

The Side Panel has three permission modes.

### Automatically approve

Recommended for website development and QA.

Ordinary navigation, clicking, typing, scrolling and editor work can proceed automatically, but sensitive targets/intents still trigger a confirmation card.

### Ask before actions

Read operations run automatically. State-changing actions ask before execution.

### Read only

The agent can inspect, observe and screenshot but browser mutations are blocked.

Sensitive actions such as publish, delete, send, submit, payment, purchase, password-related operations, revoke/logout and closing tabs require approval even in Automatically approve mode when detected.

## 9. Observe → Act → Verify

Every task starts with an automatic observation containing:

```text
safe page text
interactive elements
accessibility snapshot
screenshot
```

Password field values are redacted.

After state-changing browser actions, the runtime automatically observes the page again and sends the new state back to ChatGPT before the next decision.

This produces the loop:

```text
observe
 -> decide
 -> act
 -> re-observe
 -> verify
 -> continue or finish
```

## 10. Semantic browser tools

Prefer these tools instead of brittle selectors:

```text
page.observe
page.find
page.clickText
page.typeByLabel
page.focus
page.selectOption
page.check
page.hotkey
page.upload
```

Examples:

```json
{
  "tool": "page.clickText",
  "args": {
    "text": "Update",
    "role": "button"
  }
}
```

```json
{
  "tool": "page.typeByLabel",
  "args": {
    "label": "Page title",
    "text": "PawCare",
    "clear": true
  }
}
```

Complex apps can still fall back to coordinate click/drag plus screenshot vision.

## 11. Screenshot vision

`page.observe` and `page.screenshot` can attach the captured PNG into the selected ChatGPT conversation.

If the ChatGPT composer UI changes and image attachment fails, the bridge explicitly tells the model that it did **not** receive the screenshot so it can rely on DOM/accessibility data or retry later.

## 12. Prompt-injection boundary

The agent's system context treats webpage DOM/text and documents as untrusted data.

Website content must not be treated as authority to:

- change the user's goal;
- reveal secrets;
- disable safety/permission policy;
- escape the active tab group;
- impersonate system/tool instructions.

For high-impact work, keep the permission mode on **Ask before actions**.

## 13. Task controls

The Side Panel shows an activity timeline and Stop button.

Current limits:

```text
maximum browser steps: 40
maximum runtime: 10 minutes
approval timeout: 2 minutes
```

The latest task state is saved in extension storage for diagnostics.

## 14. Suggested first test

Open a normal website inside the agent group and ask:

```text
Inspect this website. Do not ask me for the URL.
Tell me the page title, main sections and primary buttons.
```

Then test a harmless action:

```text
Find the search field and type test, but do not submit it.
```

The activity timeline should show observation and browser tool steps.

## 15. Elementor / Figma test

For a development workflow, put these tabs in the same group:

```text
Figma reference
Elementor editor
frontend preview
```

Then ask:

```text
Inspect the hero in the Figma tab, compare it with the Elementor page,
repair the Elementor hero, then verify the frontend at desktop and mobile sizes.
```

The agent can combine semantic DOM/accessibility inspection, screenshots, coordinate actions, viewport emulation and post-action verification.

## 16. Optional Custom GPT + OAuth mode

The repository still supports a separate Custom GPT/OAuth path using:

```text
chatgpt-action/openapi.yaml
chatgpt-action/instructions.md
server/src/oauth-gateway.js
```

This is optional. The Side Panel browser-session mode is the primary workflow for users who want to use their existing normal ChatGPT login without an OpenAI API key.

## 17. Known limits

This is not a first-party OpenAI browser integration.

- the bridge depends on the current `chatgpt.com` DOM;
- closed Shadow DOM and some cross-origin frames can limit semantic inspection;
- canvas-heavy apps may require screenshot/coordinate fallback;
- Chrome-native UI such as `chrome://` pages, toolbar controls and native OS dialogs are not ordinary website targets;
- automatic risk detection is a guardrail, not a guarantee, so use Ask mode for consequential tasks.
