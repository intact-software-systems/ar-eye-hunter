import { decodeOpenApiDocument, withPublicOpenApiServer } from '@shared-server/http/public-open-api-server.ts';
import { decodeJsonWireValue, type JsonWireObject } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { Hono } from 'hono';
import { load as loadYaml } from 'js-yaml';
import { readFile } from 'node:fs/promises';

const OPENAPI_URL = '/api/relic/openapi.json';

async function loadRelicOpenApiYaml(): Promise<JsonWireObject> {
    const yamlText = await readFile(
        new URL(
            '../resources/relic-hunter-server-v1-openapi.yaml',
            import.meta.url
        ),
        'utf8'
    );
    return decodeOpenApiDocument(
        decodeJsonWireValue(loadYaml(yamlText), 'Relic Hunter OpenAPI resource'),
        'Relic Hunter OpenAPI resource'
    );
}

function swaggerHtml(): string {
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
                        persistAuthorization: true
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
        async (c) =>
            c.json(
                withPublicOpenApiServer(
                    await loadRelicOpenApiYaml(),
                    c.req.raw,
                    'Relic Hunter server'
                )
            )
    );

    app.get(
        '/api/relic/docs',
        (c) => c.html(swaggerHtml())
    );

    return app;
}
