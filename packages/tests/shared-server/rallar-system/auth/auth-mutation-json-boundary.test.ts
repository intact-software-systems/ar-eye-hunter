import { describe, expect, it } from 'vitest';

import { decodeAuthMutationCommand } from '@shared-server/rallar-system/auth/mutation/decode-auth-mutation-command.ts';
import { decodeAuthMutationIntent } from '@shared-server/rallar-system/auth/mutation/decode-auth-mutation-intent.ts';
import { decodeAuthMutationResult } from '@shared-server/rallar-system/auth/mutation/decode-auth-mutation-result.ts';

const currentIntent = {
    version: 1,
    kind: 'consume-agent-ticket',
    requestId: 'request-1',
    ticketDigest: 'ticket-digest'
};
const currentCommand = {
    ...currentIntent,
    capturedAtEpochMs: 1_000
};
const currentResult = {
    requestId: 'request-1',
    loggedOut: true
};

describe('auth mutation JSON boundary', () => {
    it.each([
        ['intent', decodeAuthMutationIntent, currentIntent],
        ['command', decodeAuthMutationCommand, currentCommand],
        ['result', decodeAuthMutationResult, currentResult]
    ])('rejects accessor-backed %s input without executing the accessor', (_label, decode, current) => {
        let accessorExecuted = false;
        const accessorBacked = { ...current };
        Object.defineProperty(accessorBacked, 'requestId', {
            enumerable: true,
            get() {
                accessorExecuted = true;
                return 'request-1';
            }
        });

        expect(() => decode(accessorBacked)).toThrow(TypeError);
        expect(accessorExecuted).toBe(false);
    });
});
