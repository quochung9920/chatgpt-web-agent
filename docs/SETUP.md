# Setup guide — browser-agent OAuth flow

This guide configures ChatGPT Web Agent `0.4.0` so daily use happens inside a normal ChatGPT account without an OpenAI API key and without a WordPress-specific plugin.

```text
ChatGPT account
   -> Custom GPT Action
   -> OAuth Gateway
   -> Browser Agent Backend
   -> Chrome Extension
   -> any website in the user's Chrome session
```

## 1. Requirements

- Node.js 20+
- A public HTTPS domain for the OAuth gateway when connecting from ChatGPT
- Chrome/Chromium with Developer Mode available for loading the extension
- Access to create/configure a Custom GPT Action

No WordPress plugin is required. WordPress, Elementor, Figma, Shopify, Webflow, and other systems are operated through Chrome.

## 2. Configure and start the server

```bash
cd server
cp .env.example .env
npm install
npm start
```

`npm start` launches `oauth-gateway.js`, which starts `browser-backend.js` privately on `INTERNAL_PORT`.

Important `.env` values:

```text
PORT=8787
PUBLIC_BASE_URL=https://agent.example.com
INTERNAL_PORT=8790
SPAWN_BACKEND=true

OAUTH_CLIENT_ID=chatgpt-web-agent
OAUTH_CLIENT_SECRET=<long random secret>
OAUTH_SIGNING_SECRET=<long random secret>
OAUTH_LOGIN_PASSWORD=<password for the Web Agent authorization page>
OAUTH_ALLOWED_REDIRECT_URIS=<exact callback URL shown by the GPT Action builder>
OAUTH_DEFAULT_SCOPE=agent:control

AGENT_ID=desktop-chrome
AGENT_TOKEN=<long random browser-agent token>
```

`INTERNAL_API_KEY` is optional. When omitted, the gateway generates an ephemeral internal credential and passes it only to the private browser backend process.

None of these values are OpenAI API keys.

## 3. HTTPS / reverse proxy

Expose the public gateway over HTTPS, for example:

```text
https://agent.example.com
```

The same host must forward WebSocket upgrades for:

```text
/agent
```

Do not expose `INTERNAL_PORT` publicly.

## 4. Install the Chrome extension

Open:

```text
chrome://extensions
```

1. Enable **Developer mode**.
2. Click **Load unpacked**.
3. Select `chrome-extension/`.
4. Open the extension Options page.
5. Configure:

```text
Server URL: wss://agent.example.com
Agent ID: desktop-chrome
Agent Token: value of AGENT_TOKEN
```

For local-only testing:

```text
ws://localhost:8787
```

The extension uses Chrome's `debugger` permission for CDP input, accessibility inspection, viewport emulation, screenshots, console diagnostics, and network diagnostics.

## 5. Browser actions

The agent can operate tabs and pages directly:

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

### DOM-first interaction

For normal forms and pages, prefer selectors and accessibility information.

Example click:

```json
{
  "action": "page.click",
  "args": { "selector": "button[type=submit]" }
}
```

Example typing:

```json
{
  "action": "page.type",
  "args": {
    "selector": "input[name=title]",
    "text": "New page title",
    "clear": true
  }
}
```

### Coordinate interaction

For Figma, Elementor canvas areas, and other custom editors where DOM selectors are unreliable:

```json
{
  "action": "page.click",
  "args": { "x": 840, "y": 410 }
}
```

Drag:

```json
{
  "action": "page.drag",
  "args": {
    "fromX": 400,
    "fromY": 300,
    "toX": 760,
    "toY": 520
  }
}
```

The agent should screenshot or inspect before using uncertain coordinates.

## 6. File upload

`page.upload` accepts file data already supplied to the current task and assigns it to a visible HTML file input.

```json
{
  "action": "page.upload",
  "args": {
    "selector": "input[type=file]",
    "filename": "hero.png",
    "mimeType": "image/png",
    "dataUrl": "data:image/png;base64,..."
  }
}
```

This does **not** expose arbitrary local filesystem access.

## 7. Check server and Chrome connection

Public health endpoint:

```bash
curl https://agent.example.com/health
```

Expected shape:

```json
{
  "ok": true,
  "service": "chatgpt-web-agent-oauth-gateway",
  "version": "0.4.0",
  "auth": "oauth2",
  "mode": "browser-agent"
}
```

Protected `/v1/*` routes require OAuth.

## 8. Create the Custom GPT

Create a Custom GPT and paste:

```text
chatgpt-action/instructions.md
```

into its Instructions.

Add an Action using:

```text
chatgpt-action/openapi.yaml
```

Replace all occurrences of:

```text
https://agent.example.com
```

with your real public gateway URL.

## 9. Configure OAuth

Use:

```text
Authorization URL: https://agent.example.com/oauth/authorize
Token URL:         https://agent.example.com/oauth/token
Client ID:         same as OAUTH_CLIENT_ID
Client Secret:     same as OAUTH_CLIENT_SECRET
Scope:             agent:control
```

The GPT builder shows an OAuth callback URL. Copy that exact URL to:

```text
OAUTH_ALLOWED_REDIRECT_URIS=
```

Then restart the server.

## 10. First authorization

When the GPT first invokes the Web Agent, ChatGPT opens:

```text
https://agent.example.com/oauth/authorize
```

Enter `OAUTH_LOGIN_PASSWORD` on that page.

This is the password for your own Web Agent service, **not** your ChatGPT password. ChatGPT itself remains authenticated normally at chatgpt.com.

## 11. OAuth endpoints

```text
GET  /.well-known/oauth-authorization-server
GET  /oauth/authorize
POST /oauth/authorize
POST /oauth/token
```

The provider supports authorization-code flow, refresh tokens, client-secret basic/post, PKCE S256, and exact redirect URI allowlisting.

## 12. Daily workflow

After setup, you can say in your Custom GPT:

```text
Open this Figma node, inspect the hero section, then reproduce it on my website.
Use the site's existing editor. Check desktop and mobile and keep fixing it until it matches.
```

Typical agent flow:

```text
1. list/open/switch to the Figma tab
2. inspect the exact reference node
3. screenshot reference evidence
4. open/switch to the destination admin/editor tab
5. inspect current UI and identify controls
6. operate the website UI directly
7. open the frontend/result tab
8. capture screenshot + DOM/accessibility/styles + errors
9. compare against reference
10. return to editor and repair
11. repeat for desktop/tablet/mobile
```

## 13. WordPress behavior

There is no Web Agent WordPress plugin.

For WordPress tasks the agent uses Chrome to:

```text
wp-admin
-> Pages / Posts / Media / Settings
-> Gutenberg or Elementor
-> Update / Save / Publish as requested
-> frontend preview
```

The same approach applies to Shopify, Webflow, and other web apps.

## 14. Credentials explained

```text
OAUTH_CLIENT_SECRET
OAUTH_SIGNING_SECRET
OAUTH_LOGIN_PASSWORD
```

secure the OAuth service you own.

```text
AGENT_TOKEN
```

secures the Chrome Extension <-> Browser Backend connection.

None of these credentials call the OpenAI API or create OpenAI API token charges.

## 15. Production recommendations

- Use HTTPS/WSS only.
- Keep `INTERNAL_PORT` private.
- Use long random secrets.
- Keep exact OAuth redirect URI allowlists.
- Rotate exposed secrets.
- Add rate limiting and an audit log for production use.
- Keep the browser action allowlist; do not add generic arbitrary JavaScript execution.
- Require explicit user intent for destructive or consequential actions.
