import { describe, expect, it } from 'vitest';

import {
    toConnectClientSessionMutationInput
} from '@shared-server/rallar-system/client-state/mutation/command-input/to-connect-client-session-mutation-input.ts';
import {
    toDisconnectClientSessionMutationInput
} from '@shared-server/rallar-system/client-state/mutation/command-input/to-disconnect-client-session-mutation-input.ts';
import { toExpireClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-expire-client-session-mutation-input.ts';
import { toHeartbeatClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-heartbeat-client-session-mutation-input.ts';
import { toUpsertClientInstanceMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-upsert-client-instance-mutation-input.ts';
import { toUpsertClientPrincipalMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-upsert-client-principal-mutation-input.ts';

const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' } as const;
const sessionTarget = {
    scope,
    principalId: 'alice',
    clientInstanceId: 'browser',
    sessionId: 'session-1'
} as const;

describe('client mutation command inputs', () => {
    it('exposes one current translator for every client mutation operation family', () => {
        expect(
            toUpsertClientPrincipalMutationInput({
                scope,
                principalId: 'alice',
                request: { username: 'alice' },
                defaultCommandId: 'principal-1'
            }).operation
        ).toBe('upsertPrincipal');
        expect(
            toUpsertClientInstanceMutationInput({
                scope,
                principalId: 'alice',
                clientInstanceId: 'browser',
                request: {},
                defaultCommandId: 'instance-1'
            }).operation
        ).toBe('upsertInstance');
        expect(
            toConnectClientSessionMutationInput({
                operation: 'connectSession',
                ...sessionTarget,
                request: { generationId: 'generation-1' },
                defaultCommandId: 'connect-1',
                identityDefaults: {}
            }).operation
        ).toBe('connectSession');
        expect(
            toHeartbeatClientSessionMutationInput({
                ...sessionTarget,
                request: { generationId: 'generation-1' },
                defaultCommandId: 'heartbeat-1'
            }).operation
        ).toBe('heartbeatSession');
        expect(
            toDisconnectClientSessionMutationInput({
                operation: 'disconnectSession',
                ...sessionTarget,
                request: { generationId: 'generation-1' },
                defaultCommandId: 'disconnect-1'
            }).operation
        ).toBe('disconnectSession');
        expect(
            toExpireClientSessionMutationInput({
                ...scope,
                principalId: 'alice',
                clientInstanceId: 'browser',
                sessionId: 'session-1',
                generationId: 'generation-1',
                generationVersion: 1,
                observedExpiresAtEpochMs: 10_000
            }).operation
        ).toBe('expireSession');
    });
});
