import type { Hono } from 'hono';

const LANDING_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Relic Hunter Server</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 48px 16px; background: #14110f; color: #f1e9dc; }
      main { max-width: 640px; margin: 0 auto; }
      h1 { margin: 0 0 8px; }
      p { color: #b9ad9b; }
      ul { list-style: none; padding: 0; display: grid; gap: 12px; }
      a { display: block; padding: 16px; border: 1px solid #4a3f33; border-radius: 8px; color: inherit; text-decoration: none; }
      a:hover { border-color: #d9a441; }
      strong { display: block; }
      span { color: #b9ad9b; font-size: 0.9em; }
    </style>
  </head>
  <body>
    <main>
      <h1>Relic Hunter Server</h1>
      <p>API documentation</p>
      <ul>
        <li>
          <a href="/api/relic/docs">
            <strong>Relic API</strong>
            <span>Game snapshots, commands, and resets</span>
          </a>
        </li>
        <li>
          <a href="/api/docs">
            <strong>Rallar API</strong>
            <span>Auth, rooms, presence, and the rest of the generic server</span>
          </a>
        </li>
      </ul>
    </main>
  </body>
</html>
`;

export function initRelicDocsLandingRoute(app: Hono): Hono {
    app.get('/', (c) => c.html(LANDING_HTML));
    app.get('/index.html', (c) => c.html(LANDING_HTML));
    return app;
}
