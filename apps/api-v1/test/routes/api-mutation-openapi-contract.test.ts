import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';

import { init } from '../../src/routes/swagger-routes.ts';

const API_MUTATION_REQUEST_ID_DESCRIPTION = 'Case-sensitive mutation request identity. ' +
  'It must contain 20 to 128 letters, digits, underscores, or hyphens.';

Deno.test('OpenAPI publishes the reusable strict API mutation request path parameter', async () => {
  const response = await init(new Hono()).request('/api/openapi.json');
  const document = await response.json() as {
    components: {
      parameters: Record<string, {
        name?: string;
        in?: string;
        required?: boolean;
        schema?: {
          type?: string;
          minLength?: number;
          maxLength?: number;
          pattern?: string;
        };
      }>;
    };
  };

  assert.deepEqual(document.components.parameters.ApiMutationRequestId, {
    name: 'requestId',
    in: 'path',
    required: true,
    description: API_MUTATION_REQUEST_ID_DESCRIPTION,
    schema: {
      type: 'string',
      minLength: 20,
      maxLength: 128,
      pattern: '^[A-Za-z0-9_-]+$',
    },
  });
});
