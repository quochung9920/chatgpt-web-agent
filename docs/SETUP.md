# Setup guide — OAuth Custom GPT flow

This guide configures ChatGPT Web Agent `0.3.0` so daily use happens inside a normal ChatGPT account without an OpenAI API key.

```text
ChatGPT account
   -> Custom GPT Action
   -> OAuth Gateway
   -> Web Agent backend
   -> Chrome Extension + WordPress Plugin
```

## 1. Requirements

- Node.js 20+
- A public HTTPS domain for the OAuth gateway when connecting from ChatGPT
- Chrome/Chromium with Developer Mode available for loading the extension
- A WordPress site where you can install the included plugin
- Access to create/configure a Custom GPT Action

## 2. Configure and start the server

```bash
cd server
cp .env.example .env
npm install
npm start
```

`npm start` now launches `oauth-gateway.js`. The gateway automatically starts the existing backend on `INTERNAL_PORT`.

Important `.env` values:

```text
PORT=8787
PUBLIC_BASE_URL=https://agent.example.com
INTERNAL_PORT=8790
SPAWN_BACKEND=true

OAUTH_CLIENT_ID=chatgpt-web-agent
OAUTH_CLIENT_SECRET=<long random secret>
OAUTH_SIGNING_SECRET=<long random secret>
OAUTH_LOGIN_PASSWORD=<password you will enter on the Web Agent authorization page>
OAUTH_ALLOWED_REDIRECT_URIS=<exact callback URL shown by the GPT Action builder>
OAUTH_DEFAULT_SCOPE=agent:control

AGENT_ID=desktop-chrome
AGENT_TOKEN=<long random internal browser token>

WORDPRESS_BASE_URL=https://example.com
WORDPRESS_TOKEN=<token from the WordPress plugin>
```

`INTERNAL_API_KEY` is optional. When omitted, the gateway creates an ephemeral internal credential and passes it only to the private backend process. This key is not shown to ChatGPT.

None of the credentials above are OpenAI API keys.

## 3. HTTPS / reverse proxy

Your Custom GPT must be able to reach the gateway over HTTPS. Point a domain such as:

```text
https://agent.example.com
```

to the public gateway port.

The same host should forward WebSocket upgrades for:

```text
/agent
```

The gateway proxies that WebSocket to the internal backend automatically.

Do not expose `INTERNAL_PORT` publicly if your deployment/firewall can avoid it.

## 4. Install the WordPress plugin

Copy:

```text
wordpress-plugin/
```

to:

```text
wp-content/plugins/chatgpt-web-agent/
```

Activate **ChatGPT Web Agent**, then open:

```text
Settings -> ChatGPT Web Agent
```

Copy the generated token into:

```text
WORDPRESS_TOKEN=
```

The plugin exposes only its allowlisted page/Gutenberg/media/CSS operations.

## 5. Install the Chrome extension

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

For local-only testing, use:

```text
ws://localhost:8787
```

The extension uses Chrome's `debugger` permission for viewport emulation, full-page/element screenshots, console diagnostics, and network diagnostics.

## 6. Check server and Chrome connection

The public health endpoint does not require OAuth:

```bash
curl https://agent.example.com/health
```

Expected shape:

```json
{
  "ok": true,
  "service": "chatgpt-web-agent-oauth-gateway",
  "version": "0.3.0",
  "auth": "oauth2"
}
```

Protected `/v1/*` endpoints are intentionally not usable with a normal static API key on the public gateway. They require an OAuth access token.

## 7. Create the Custom GPT

Create a Custom GPT and use:

```text
chatgpt-action/instructions.md
```

as the main operating instructions.

Add an Action by importing:

```text
chatgpt-action/openapi.yaml
```

Before importing, replace every occurrence of:

```text
https://agent.example.com
```

with your real public gateway URL.

## 8. Configure Action OAuth

In the Action authentication settings choose OAuth and use:

```text
Authorization URL: https://agent.example.com/oauth/authorize
Token URL:         https://agent.example.com/oauth/token
Client ID:         same as OAUTH_CLIENT_ID
Client Secret:     same as OAUTH_CLIENT_SECRET
Scope:             agent:control
```

The GPT builder will show an OAuth callback/redirect URL. Copy that exact URL into:

```text
OAUTH_ALLOWED_REDIRECT_URIS=
```

Then restart the server.

Multiple exact callback URLs can be comma-separated if necessary.

## 9. First authorization

When the GPT first invokes the Web Agent Action, ChatGPT opens:

```text
https://agent.example.com/oauth/authorize
```

The page asks for:

```text
Web Agent access password
```

Enter the value of:

```text
OAUTH_LOGIN_PASSWORD
```

This is **not** your ChatGPT password. Your ChatGPT account is already authenticated by chatgpt.com; this OAuth step only grants that GPT access to your private Web Agent.

After authorization, the gateway returns an OAuth authorization code to ChatGPT, ChatGPT exchanges it for an access token, and refresh tokens keep the connection usable without an OpenAI API key.

## 10. OAuth endpoints

Discovery metadata:

```text
GET /.well-known/oauth-authorization-server
```

Authorization:

```text
GET/POST /oauth/authorize
```

Token exchange / refresh:

```text
POST /oauth/token
```

The provider supports:

- authorization code grant;
- refresh token grant;
- client secret basic;
- client secret post;
- optional PKCE S256;
- exact redirect URI allowlisting.

## 11. Intended daily workflow

After the one-time setup, you work in ChatGPT:

```text
"Build the homepage hero from this Figma node and verify it in Chrome."
```

The GPT should:

```text
1. inspect the exact Figma/HTML reference
2. inspect the current WordPress page
3. create/update an implementation target
4. build Gutenberg + media + Web Agent CSS
5. open/reload the real frontend in Chrome
6. inspect DOM/computed styles/console/network
7. capture desktop QA
8. compare and repair
9. repeat for tablet and mobile
10. finish only when required viewports pass or a genuine blocker exists
```

## 12. Figma behavior

If the GPT has a Figma connector/tool available, use the exact node-specific design context first.

If not, the connected Chrome session can navigate to the exact Figma node URL using the user's existing Figma login session. The Web Agent must never ask for or store the user's Figma password.

## 13. Credentials explained

```text
OAUTH_CLIENT_SECRET
OAUTH_SIGNING_SECRET
OAUTH_LOGIN_PASSWORD
```

secure the OAuth service you own.

```text
AGENT_TOKEN
```

secures the Chrome extension connection.

```text
WORDPRESS_TOKEN
```

secures the WordPress plugin connection.

None of these call OpenAI's API or cause OpenAI API token charges.

## 14. Production recommendations

- Use HTTPS/WSS only.
- Keep `INTERNAL_PORT` private.
- Use long random secrets.
- Set an exact `OAUTH_ALLOWED_REDIRECT_URIS` list.
- Rotate secrets after exposure.
- Keep destructive operations outside the tool surface unless explicit approval rules are added.
- Keep the browser action allowlist; do not add generic arbitrary JavaScript execution.
- Add rate limiting and an audit log before broad production use.
- Prefer draft pages during early testing.
