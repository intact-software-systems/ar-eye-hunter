# Shared run configurations

Open the repository root in WebStorm or IntelliJ IDEA with the JavaScript and Bun plugins enabled.
Install the workspace dependencies and configure the IDE's Node.js and Bun runtimes first.

| IDE folder | Entries | Action |
| --- | --- | --- |
| Bun Servers | API v1, AR Eye Hunter, Relic Hunter, Rallar Black Box Control | **Run** starts the server with watch mode; **Debug** starts it with the native Bun debugger. |
| React SPAs | AR Eye Hunter, Relic Hunters, Rallar Black Box | **Run** starts the app's Vite development server. |
| JavaScript Debug | Browser Debug for each React SPA | **Run** starts the SPA and automatically launches Chrome with the JavaScript debugger. |
| Tools | Rallar Black Box Headless | **Run** starts the headless runner's Vite app. |

The browser-debug entries use npm's **Launch Browser / Start JavaScript debugger after launch**
integration. This starts Vite and the browser debugger together without a before-launch task
waiting indefinitely for the development server to exit. Set breakpoints in the SPA source,
then run its **Browser Debug** entry. Do not start its separate SPA entry at the same time:
both use the same fixed port. Stop the existing SPA session before switching launch modes.

| App | Browser URL |
| --- | --- |
| AR Eye Hunter | http://localhost:5174 |
| Relic Hunters | http://localhost:5175 |
| Rallar Black Box | http://localhost:5176 |
| Rallar Black Box Headless | http://localhost:5179/headless/ |

Bun configurations use each server's `src/main.ts` and app directory, preserving its `dev`
script's watch and environment-file options. Set server breakpoints and use **Debug** on the
same server entry; no separate attach configuration is needed. Server dependencies and local
environment files still need to be available. Browser-debug entries start only their SPA;
start the backend services needed for the feature separately. AR Eye Hunter retains its existing
`API_BASE_URL=http://localhost:8080` setting in both SPA launch modes.

All paths are relative to `$PROJECT_DIR$`. Runtime executable paths and secret values stay in
local IDE settings and environment files.
