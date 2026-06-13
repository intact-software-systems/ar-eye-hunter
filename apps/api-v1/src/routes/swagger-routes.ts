import { Context, Hono } from 'jsr:@hono/hono';
import { resolvePublicServerUrl, withPublicOpenApiServer, } from '@shared-server/http/public-server-url.ts';
import { loadOpenApiYaml } from '../config-repo.ts';

export { resolvePublicServerUrl };

function swaggerHtml(c: Context): string {
    const serverUrl = resolvePublicServerUrl(c.req.raw);
    const openApiUrl = '/api/openapi.json';

    return `
        <!doctype html>
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
              window.onload = function () {
                  window.ui = SwaggerUIBundle({
                        url: '${openApiUrl}',
                        dom_id: '#swagger-ui',
                        persistAuthorization: true,
                        requestInterceptor: (req) => {
                          // Vi sjekker om forespørselen er for selve OpenAPI-filen
                          if (req.url.endsWith(${JSON.stringify(openApiUrl)})) {
                            req.userFetch = async (url, options) => {
                              const res = await fetch(url, options);
                              const json = await res.json();
                              
                              // Vi injiserer/overskriver servers-feltet direkte i JSON-objektet
                              json.servers = [{ 
                                url: ${JSON.stringify(serverUrl)}, 
                                description: 'Rallar server' 
                              }];
                              
                              // Returnerer det modifiserte objektet som om det kom fra serveren slik
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

export function init(app: Hono) {
    app.get(
        '/api/openapi.json',
        async (c) =>
            c.json(
                withPublicOpenApiServer(
                    await loadOpenApiYaml(),
                    c.req.raw,
                    'Rallar server',
                ),
            ),
    );

    app.get(
        '/api/docs',
        (c) => c.html(swaggerHtml(c)),
    );

    app.get(
        '/swagger-ui',
        (c) => c.html(swaggerHtml(c)),
    );

    app.get(
        '/openapi.json',
        async (c) =>
            c.json(
                withPublicOpenApiServer(
                    await loadOpenApiYaml(),
                    c.req.raw,
                    'Rallar server',
                ),
            ),
    );

    app.get('*', (c) => c.redirect('/swagger-ui'));

    return app;
}
