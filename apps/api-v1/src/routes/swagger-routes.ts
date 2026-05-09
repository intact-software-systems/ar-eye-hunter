import { Hono } from 'jsr:@hono/hono';
import { loadOpenApiYaml } from '../config-repo.ts';

function swaggerHtml(openApiUrl: string): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AR Eye Hunter API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: ${JSON.stringify(openApiUrl)},
        dom_id: '#swagger-ui',
        persistAuthorization: true
      });
    </script>
  </body>
</html>`;
}

export function init(app: Hono) {
    app.get(
        '/api/openapi.json',
        async c => c.json(await loadOpenApiYaml())
    );

    app.get(
        '/api/docs',
        c => c.html(swaggerHtml('/api/openapi.json'))
    );

    app.get(
        '/swagger-ui',
        c => c.html(swaggerHtml('/api/openapi.json'))
    );

    app.get(
        '/openapi.json',
        async c => c.json(await loadOpenApiYaml())
    );

    app.get('*', c =>
        c.redirect('/swagger-ui')
    );

    return app;
}
