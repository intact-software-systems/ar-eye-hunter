import { describe, expect, it } from 'vitest';
import { projectExecuteOperationError } from '../../../apps/rallar-black-box/src/recipe-console/execute/execute-operation-error.ts';

describe('Recipe Console Execute operation errors', () => {
    it('preserves credential, control, and broker provenance', () => {
        const error = Object.assign(new Error('Configured token broker rejected the session.'), {
            authorizationRequired: true,
            credentialTrustRequired: true,
            controlStatus: 401,
            controlStatusText: 'Unauthorized',
            brokerStatus: 403,
            brokerStatusText: 'Forbidden',
            reachable: true,
        });

        expect(projectExecuteOperationError(error)).toEqual({
            kind: 'credential-trust',
            name: 'Error',
            message: 'Configured token broker rejected the session.',
            authorizationRequired: true,
            credentialTrustRequired: true,
            controlStatus: 401,
            controlStatusText: 'Unauthorized',
            brokerStatus: 403,
            brokerStatusText: 'Forbidden',
            reachable: true,
        });
    });

    it('distinguishes protocol, HTTP, network, and unknown failures', () => {
        expect(projectExecuteOperationError(Object.assign(
            new Error('Malformed control response.'),
            { name: 'RecipeConsoleControlProtocolError', reachable: true },
        )).kind).toBe('protocol');
        expect(projectExecuteOperationError(Object.assign(
            new Error('Conflict'),
            { status: 409, statusText: 'Conflict' },
        ))).toMatchObject({ kind: 'http', status: 409, statusText: 'Conflict' });
        expect(projectExecuteOperationError(new TypeError('Failed to fetch')).kind)
            .toBe('network');
        expect(projectExecuteOperationError('opaque failure')).toMatchObject({
            kind: 'unknown',
            message: 'opaque failure',
        });
    });
});
