import { type Context, Hono } from 'jsr:@hono/hono';
import { parse } from 'jsr:@std/yaml';

const OPENAPI_URL = '/api/relic/openapi.json';

async function loadRelicOpenApiYaml(): Promise<unknown> {
  const yamlText = await Deno.readTextFile(
    new URL('../resources/relic-hunter-server-v1-openapi.yaml', import.meta.url),
  );
  return parse(yamlText);
}

function swaggerHtml(c: Context): string {
  const url = new URL(c.req.url);
  const serverUrl = `${url.protocol}//${url.host}`;

  return `
        <!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>Relic Hunter Server API Docs</title>
            <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
          </head>
          <body>
            <div id="swagger-ui"></div>
            <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
            <script>
              window.onload = function () {
                  window.ui = SwaggerUIBundle({
                        url: '${OPENAPI_URL}',
                        dom_id: '#swagger-ui',
                        persistAuthorization: true,
                        requestInterceptor: (req) => {
                          if (req.url.endsWith(${JSON.stringify(OPENAPI_URL)})) {
                            req.userFetch = async (url, options) => {
                              const res = await fetch(url, options);
                              const json = await res.json();
                              json.servers = [{
                                url: ${JSON.stringify(serverUrl)},
                                description: 'Relic Hunter server'
                              }];
                              return new Response(JSON.stringify(json));
                            };
                          }
                          return req;
                        }
                      });
                    };
            </script>
          </body>
        </html>
`;
}

export function initRelicSwaggerRoutes(app: Hono): Hono {
  app.get(
    OPENAPI_URL,
    async (c) => c.json(await loadRelicOpenApiYaml()),
  );

  app.get(
    '/api/relic/docs',
    (c) => c.html(swaggerHtml(c)),
  );

  return app;
}
