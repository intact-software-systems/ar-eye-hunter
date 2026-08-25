import { describe, expect, it } from 'vitest';

import { decodeOpenApiDocument, withPublicOpenApiServer } from '@shared-server/http/public-open-api-server.ts';

describe('public OpenAPI server publication', () => {
    it('rejects a scalar OpenAPI document', () => {
        expect(() => decodeOpenApiDocument('openapi: invalid')).toThrow(
            'OpenAPI document must decode to an object'
        );
    });

    it('rejects non-JSON-safe configuration values', () => {
        expect(() => decodeOpenApiDocument({ openapi: '3.1.0', invalid: undefined })).toThrow(
            'OpenAPI document must be JSON-safe'
        );
    });

    it('publishes the request-facing server without mutating the decoded document', () => {
        const document = decodeOpenApiDocument({
            openapi: '3.1.0',
            servers: [{ url: 'http://configured.example' }]
        });

        const published = withPublicOpenApiServer(
            document,
            new Request('http://internal:8080/openapi.json', {
                headers: {
                    'x-forwarded-proto': 'https',
                    'x-forwarded-host': 'api.rallar.example'
                }
            }),
            'Rallar server'
        );

        expect(published.servers).toEqual([{
            url: 'https://api.rallar.example',
            description: 'Rallar server'
        }]);
        expect(document.servers).toEqual([{ url: 'http://configured.example' }]);
    });
});
