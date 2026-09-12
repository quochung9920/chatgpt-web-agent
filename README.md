# ChatGPT Web Agent

A browser-first agent bridge that lets a normal ChatGPT Custom GPT operate the user's own Chrome session directly through OAuth — without an OpenAI API key and without platform-specific plugins.

## Architecture

```text
ChatGPT at chatgpt.com
        |
        | OAuth 2.0
        v
+-------------------------+
| Web Agent OAuth Gateway |
+------------+------------+
             |
             | private internal auth
             v
+-------------------------+
| Browser Agent Backend   |
+------------+------------+
             |
             | WebSocket
             v
+-------------------------+
| Chrome Extension        |
+------------+------------+
             |
             v
      Real Chrome session
             |
   +---------+----------+
   |         |          |
 Figma   WordPress   Shopify / any website
```

WordPress is **not** a special integration. If ChatGPT needs to edit WordPress, it opens `wp-admin` in Chrome and operates Gutenberg, Elementor, Media Library, settings, or other visible UI just like a human user.

## Why browser-first

The project is designed for tasks such as:

> Open this exact Figma section, reproduce it on my website, then inspect the result in Chrome and keep fixing it until desktop and mobile match.

The same agent can work with WordPress, Elementor, Figma, Shopify, Webflow, dashboards, and other web apps without installing a server plugin for every platform.

## Interaction model

The extension supports two complementary modes.

### DOM / accessibility mode

Prefer this when the website exposes useful semantic elements:

```text
page.read
page.accessibility
page.inspect
page.elements
selector-based click/type
```

### Visual / coordinate mode

Use this for canvas-heavy or custom interfaces such as Figma and some visual editors:

```text
page.screenshot
page.elementAt
page.click       x/y
page.hover       x/y
page.drag        x/y -> x/y
page.doubleClick
page.rightClick
```

The agent should inspect or screenshot before using uncertain coordinates.

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

`page.upload` can place file data supplied by the current task into an HTML file input. It does not grant arbitrary filesystem access.

## Design verification loop

The server keeps optional implementation targets and visual verification state:

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

A target only becomes `complete` when every configured viewport passes.

## Repository structure

```text
chatgpt-web-agent/
├── chrome-extension/
│   ├── manifest.json
│   ├── background.js
│   ├── options.html
│   └── options.js
├── server/
│   ├── .env.example
│   ├── package.json
│   └── src/
│       ├── browser-backend.js
│       ├── oauth.js
│       ├── oauth-gateway.js
│       └── target-store.js
├── chatgpt-action/
│   ├── openapi.yaml
│   └── instructions.md
├── docs/
│   └── SETUP.md
└── openapi.yaml
```

There is intentionally no WordPress plugin in the architecture.

## Quick start

### 1. Server

```bash
cd server
cp .env.example .env
npm install
npm start
```

Configure OAuth and Chrome agent secrets in `.env`. These are credentials for your own Web Agent service; they are not OpenAI API keys.

### 2. Chrome extension

Open:

```text
chrome://extensions
```

Enable Developer Mode, choose **Load unpacked**, and select `chrome-extension/`.

In the extension Options page configure:

```text
Server URL: wss://agent.your-domain.com
Agent ID: desktop-chrome
Agent Token: same AGENT_TOKEN as the server
```

For local development, use `ws://localhost:8787`.

The extension requests Chrome's `debugger` permission for CDP input, viewport emulation, accessibility inspection, screenshots, console capture, and network diagnostics.

### 3. Custom GPT

Create a Custom GPT in ChatGPT and:

- paste `chatgpt-action/instructions.md` into its Instructions;
- import `chatgpt-action/openapi.yaml` as its Action schema;
- replace `https://agent.example.com` with your public HTTPS Web Agent URL;
- configure Action authentication as OAuth using `/oauth/authorize` and `/oauth/token`;
- copy the callback URL shown by the GPT builder into `OAUTH_ALLOWED_REDIRECT_URIS`.

The user remains logged in to ChatGPT normally at chatgpt.com. No OpenAI API key is used by this project.

See [`docs/SETUP.md`](docs/SETUP.md) for full setup.

## Example workflow

User:

```text
Open this Figma node and recreate the hero on my WordPress homepage.
Use Elementor if that page is using Elementor. Check desktop and mobile yourself.
```

Agent flow:

```text
open/switch Figma tab
-> inspect exact node
-> capture reference
-> open wp-admin tab
-> navigate through WordPress/Elementor UI
-> build section
-> open frontend tab
-> screenshot + inspect
-> compare
-> return to editor and repair
-> repeat until required viewports pass
```

No WordPress-specific REST bridge is involved.

## Security model

```text
ChatGPT Custom GPT -- OAuth --> Web Agent Gateway
Web Agent Gateway -- private internal key --> Browser Backend
Browser Backend -- AGENT_TOKEN/WebSocket --> Chrome Extension
Chrome Extension --> user-approved Chrome session
```

Safeguards:

- browser actions are explicitly allowlisted;
- arbitrary remote JavaScript execution is not exposed;
- OAuth is separate from the user's ChatGPT password;
- Chrome/website passwords are not sent to ChatGPT by this project;
- file upload accepts supplied task data only and does not expose the local filesystem;
- destructive external actions should only be taken when explicitly requested;
- HTTPS/WSS should be used in production.

## Version

`0.4.0` — browser-agent architecture. Platform-specific WordPress integration was removed from the main project.
