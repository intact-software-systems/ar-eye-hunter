import type { AuthSession } from '@shared/api/api-config.ts';

import type { RallarDataScope } from '../rallar-data.ts';

export interface RallarSessionIdentity {
    resolveDataScopeKey(scope: RallarDataScope): string;
}

export interface CreateRallarSessionIdentityInput {
    readonly readSession: () => AuthSession | undefined;
}

export function createRallarSessionIdentity(
    input: CreateRallarSessionIdentityInput
): RallarSessionIdentity {
    return {
        resolveDataScopeKey: (scope): string => {
            if (scope === 'app') {
                return 'app';
            }

            if (scope !== 'principal' && scope !== 'session') {
                return String(scope);
            }

            const session = input.readSession();
            if (!session) {
                throw new Error('Rallar requires an auth session.');
            }

            return scope === 'principal'
                ? `principal:${session.clientId}`
                : `session:${session.sessionId}`;
        }
    };
}
