import { createRallarSessionIdentity } from '@shared-web/browser/session/session-identity.ts';
import { describe, expect, it } from 'vitest';

describe('Rallar session identity', () => {
    it('resolves application and explicit scopes without requiring a current auth session', () => {
        const identity = createRallarSessionIdentity({
            readSession: () => undefined
        });

        expect(identity.resolveDataScopeKey('app')).toBe('app');
        expect(identity.resolveDataScopeKey('game:match-1')).toBe('game:match-1');
    });
});
