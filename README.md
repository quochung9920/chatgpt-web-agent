# ChatGPT Web Agent

A bridge for using a normal ChatGPT account as a **design → build → Chrome QA → repair** agent for your own websites, without calling the OpenAI API.

## Version 0.3 architecture

```text
You sign in normally at chatgpt.com
          |
          v
Custom GPT + Actions
          |
          | OAuth 2.0 authorization code
          v
OAuth Gateway
          |
          | private generated internal credential
          v
Web Agent backend
     +----+----+
     |         |
     v         v
Chrome      WordPress
Extension    Plugin
```

The OAuth login is for **your Web Agent service**, not for OpenAI. Your ChatGPT account remains logged in at chatgpt.com and the model usage stays inside your ChatGPT plan/limits. This repository does not require an OpenAI API key.

## Repository structure

```text
chatgpt-web-agent/
├── openapi.yaml
├── chatgpt-action/
│   ├── openapi.yaml
│   └── instructions.md
├── server/
│   ├── .env.example
│   ├── package.json
│   └── src/
│       ├── oauth-gateway.js
│       ├── oauth.js
│       ├── index.js
│       └── target-store.js
├── chrome-extension/
├── wordpress-plugin/
└── docs/
    └── SETUP.md
```

## What 0.3 adds

- OAuth 2.0 authorization-code gateway for Custom GPT Actions.
- Access + refresh tokens signed by your own server.
- Exact OAuth redirect allowlist.
- Optional PKCE S256 verification.
- Public ChatGPT-facing `/v1/*` routes require OAuth.
- Existing backend is moved behind the gateway and receives only an internal credential.
- The gateway proxies the Chrome WebSocket `/agent`, so the extension still uses the same public host.
- `npm start` launches the OAuth gateway and automatically starts the existing backend.

## Existing implementation/QA capabilities

### Chrome

```text
tabs.list
tab.active
tab.navigate
tab.reload
page.wait
page.read
page.inspect
page.elements
page.click
page.type
page.scroll
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

The extension supports viewport emulation, computed-style/bounding-box inspection, full-page/element screenshots, console diagnostics, and network diagnostics.

### WordPress

- inspect site/theme/registered blocks;
- list/read/create/update pages;
- parse Gutenberg block trees;
- search/import media;
- maintain a reversible Web-Agent-owned CSS layer.

### Visual repair loop

- persistent implementation targets;
- desktop/tablet/mobile verification state;
- screenshot capture;
- image similarity and pixel-difference metrics;
- target states: `draft → building → verifying → repairing → complete`;
- a target reaches `complete` only when all required viewports pass.

## Quick start

```bash
cd server
cp .env.example .env
npm install
npm start
```

Configure the OAuth variables in `.env`, especially:

```text
PUBLIC_BASE_URL=https://agent.example.com
OAUTH_CLIENT_ID=chatgpt-web-agent
OAUTH_CLIENT_SECRET=...
OAUTH_SIGNING_SECRET=...
OAUTH_LOGIN_PASSWORD=...
OAUTH_ALLOWED_REDIRECT_URIS=<callback URL shown by the GPT Action builder>
```

Then install:

1. `wordpress-plugin/` in WordPress and copy its generated token into `WORDPRESS_TOKEN`.
2. `chrome-extension/` with Chrome **Load unpacked** and configure the public gateway URL plus `AGENT_ID` / `AGENT_TOKEN`.
3. Create a Custom GPT, paste `chatgpt-action/instructions.md` into its Instructions, and import `chatgpt-action/openapi.yaml` as an Action.
4. Configure that Action to use OAuth with the URLs shown below.

```text
Authorization URL: https://agent.example.com/oauth/authorize
Token URL:         https://agent.example.com/oauth/token
Client ID:         value of OAUTH_CLIENT_ID
Client Secret:     value of OAUTH_CLIENT_SECRET
Scope:             agent:control
```

When ChatGPT first uses the Action, it opens the Web Agent authorization page. Enter `OAUTH_LOGIN_PASSWORD` once to authorize the GPT. Do **not** enter your ChatGPT password there.

## Intended workflow

```text
"Build this WordPress section from this Figma node."
        |
        v
Inspect exact Figma node / HTML reference
        |
        v
Inspect current WordPress implementation
        |
        v
Create implementation TARGET
        |
        v
Build Gutenberg + assets + Web Agent CSS
        |
        v
Open real Chrome and capture QA evidence
        |
        v
Compare reference vs implementation
        |
   mismatch? ---- yes ----> repair and verify again
        |
        no
        v
Verify remaining viewports -> complete
```

If a Figma connector is available to the GPT, use the exact node-specific design context. Otherwise the agent can use the user's logged-in Chrome session to navigate to the Figma node for browser-based inspection. Passwords for Figma/WordPress should never be sent to the GPT; use the user's existing browser sessions or the WordPress bridge.

## Security boundaries

```text
Custom GPT -- OAuth access token --> OAuth Gateway
OAuth Gateway -- generated internal token --> private backend
Backend -- AGENT_TOKEN --> Chrome Extension
Backend -- WORDPRESS_TOKEN --> WordPress Plugin
```

`AGENT_TOKEN`, `WORDPRESS_TOKEN`, `OAUTH_CLIENT_SECRET`, and `OAUTH_SIGNING_SECRET` are credentials for your own infrastructure. They are not OpenAI API keys and do not create OpenAI API usage charges.

The browser action surface remains allowlisted and does not expose generic arbitrary JavaScript execution. Destructive WordPress/plugin/theme operations are intentionally excluded.

See [`docs/SETUP.md`](docs/SETUP.md) for the complete setup process.
