# ChatGPT Web Agent

A browser-first agent bridge for controlling and inspecting the user's real Chrome session. Version 0.6 adds a Chrome Side Panel that can chat through an existing logged-in `chatgpt.com` tab, so the user can keep the website visible while chatting beside it.

No OpenAI API key is required for the browser-session chat mode.

## v0.6 architecture

```text
Windows Chrome
+--------------------------------------------------+
| Website / Figma / WordPress / Shopify            |
|                                      +---------+ |
|                                      | Side    | |
|                                      | Panel   | |
|                                      | ChatGPT | |
|                                      +----+----+ |
|                                           |      |
|                         logged-in ChatGPT tab    |
+-------------------------------------------+------+
                                            |
                                Chrome extension
                                            |
                                         WebSocket
                                            |
                                      WSL Web Agent
```

The ChatGPT session remains inside Chrome. The extension does not copy ChatGPT cookies or session tokens to WSL. It sends text to the selected logged-in ChatGPT tab and mirrors the visible conversation back into the extension side panel.

This browser-session bridge is based on the ChatGPT web UI and is therefore less stable than an official API/integration; selectors may need updates when the ChatGPT website changes.

## Two ChatGPT connection modes

### 1. Side Panel chat mode

Use the existing ChatGPT login in the same Chrome profile:

```text
Side Panel
  -> selected chatgpt.com tab
  -> ChatGPT web session
  -> answer returned to Side Panel
```

This is the mode for users who want to chat directly inside the extension while keeping the target website open.

### 2. Custom GPT + OAuth mode

The repository still contains `chatgpt-action/` and the OAuth gateway for users who want a Custom GPT Action connected to the Web Agent server.

```text
Custom GPT
   -> OAuth
   -> Web Agent gateway
   -> browser backend
   -> Chrome extension
```

## Browser-first architecture

WordPress is not a special integration. The agent can operate WordPress, Elementor, Figma, Shopify, Webflow, dashboards, and other websites through the real Chrome UI.

```text
Web Agent backend
       |
       | WebSocket
       v
Chrome Extension
       |
       +-> DOM / accessibility
       +-> visual / coordinates
       +-> keyboard / click / drag
       +-> screenshots
       +-> console / network
```

## Browser capabilities

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
page.inspect
page.elements
page.elementAt
page.accessibility

page.click
page.doubleClick
page.rightClick
page.hover
page.type
page.key
page.scroll
page.drag
page.upload

page.viewport.get
page.viewport.set
page.viewport.clear
page.screenshot
page.elementScreenshot

debug.start
debug.logs
debug.clear
debug.stop
```

## Chrome extension structure

```text
chrome-extension/
├── manifest.json
├── service-worker.js
├── background.js
├── chatgpt-content.js
├── sidepanel.html
├── sidepanel.css
├── sidepanel.js
├── options.html
└── options.js
```

`chatgpt-content.js` is injected only into the selected ChatGPT tab when the Side Panel needs to communicate with the logged-in ChatGPT web session.

## Quick start

### 1. Run the server in WSL

```bash
cd ~/projects/chatgpt-web-agent/server
npm install
npm start
```

For local Windows Chrome usage:

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

Click the extension icon to open the Side Panel.

### 3. Chat inside the extension

Make sure at least one `https://chatgpt.com/` tab is logged in in the same Chrome profile.

The Side Panel will:

1. discover ChatGPT tabs;
2. let you select one;
3. sync its visible conversation;
4. send prompts from the Side Panel;
5. wait for ChatGPT's response;
6. show the response in the Side Panel.

You can create a new ChatGPT tab from the Side Panel without leaving the current website.

## Design verification loop

The Web Agent backend still provides optional target and visual verification primitives:

```text
reference
 -> inspect destination
 -> operate website UI
 -> screenshot
 -> DOM/style/error inspection
 -> compare
 -> repair
 -> repeat desktop/tablet/mobile
```

## Security model

```text
ChatGPT login/session  -> stays in Chrome
Side Panel             -> exchanges visible chat text with ChatGPT tab
Chrome Extension       -> controls browser through allowlisted actions
Browser Backend        -> receives AGENT_TOKEN/WebSocket connection
```

Safeguards:

- ChatGPT cookies/session tokens are not exported to WSL;
- browser actions are explicitly allowlisted;
- arbitrary remote JavaScript execution is not exposed;
- file upload accepts supplied task data only and does not expose arbitrary local files;
- destructive actions should only be taken when explicitly requested;
- HTTPS/WSS should be used for remote deployments.

## Custom GPT OAuth mode

For the optional OAuth flow, see:

```text
chatgpt-action/openapi.yaml
chatgpt-action/instructions.md
docs/SETUP.md
```

## Version

`0.6.0` — Chrome Side Panel ChatGPT web-session bridge plus browser-agent architecture.
