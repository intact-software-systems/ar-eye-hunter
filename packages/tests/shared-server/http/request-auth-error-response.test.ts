import { authenticationRequired, toAuthErrorResponse, type RequestAuthErrorResponse } from '@shared-server/http/request-auth-service.ts';
import { describe, expect, it } from 'vitest';

describe('request authentication error responses', () => {
    it('does not trust status properties on untyped errors', async () => {
        const untypedError = Object.assign(new Error('Authentication dependency failed'), {
            status: 503
        });

        const response = toAuthErrorResponse(createJsonContext(), untypedError);

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
            error: 'Authentication dependency failed'
        });
    });

    it('uses the status owned by a typed authentication failure', async () => {
        const response = toAuthErrorResponse(
            createJsonContext(),
            authenticationRequired('Unauthorized: Missing bearer token')
        );

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
            error: 'Unauthorized: Missing bearer token'
        });
    });
});

function createJsonContext(): {
    readonly json: (
        value: RequestAuthErrorResponse,
        status?: number
    ) => Response;
} {
    return {
        json: (value, status = 200) => Response.json(value, { status })
    };
}
