import { decodeOpenApiDocument, withPublicOpenApiServer } from '@shared-server/http/public-open-api-server.ts';
import type { JsonWireObject } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import { parse } from 'jsr:@std/yaml@1.0.12';

async function loadOpenApiYaml(): Promise<JsonWireObject> {
    return decodeOpenApiDocument(
        parse(
            await Deno.readTextFile(
                new URL('../../resources/api-v1-openapi.yaml', import.meta.url)
            )
        ),
        'API-v1 OpenAPI resource'
    );
}

function swaggerHtml(): string {
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
                        persistAuthorization: true
                      });
                    };
            </script>
          </body>
        </html>
`;
}

export function installApiDocumentationRoutes(app: Hono): Hono {
    app.get(
        '/api/openapi.json',
        async (c) =>
            c.json(
                withPublicOpenApiServer(
                    await loadOpenApiYaml(),
                    c.req.raw,
                    'Rallar server'
                )
            )
    );

    app.get(
        '/api/docs',
        (c) => c.html(swaggerHtml())
    );

    app.get(
        '/swagger-ui',
        (c) => c.html(swaggerHtml())
    );

    app.get(
        '/openapi.json',
        async (c) =>
            c.json(
                withPublicOpenApiServer(
                    await loadOpenApiYaml(),
                    c.req.raw,
                    'Rallar server'
                )
            )
    );

    app.get('*', (c) => c.redirect('/swagger-ui'));

    return app;
}
