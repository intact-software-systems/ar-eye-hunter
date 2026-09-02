import { describe, expect, it } from 'vitest';

import type { GroupStateMutationCommand } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { readGroupPresenceConnect } from '@shared-server/rallar-system/group-state/presence/group-presence-service.ts';
import { createWsSessionGenerationLifecycleService } from '@shared-server/rallar-system/websocket/ws-session-generation-lifecycle.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

describe('group presence connect decision', () => {
    it('returns inactive without reading or computing a group mutation', async () => {
        const repository = new FakeRuntimeStateRepository();
        const lifecycle = createWsSessionGenerationLifecycleService(repository);
        const state = {
            version: 3,
            status: 'closed',
            scope: { kind: 'group', applicationId: 'ar-eye-hunter', workspaceId: 'default', principalId: 'owner' },
            sessionId: 'session-1',
            generationId: 'generation-1',
            generationStartedAtEpochMs: 1_000,
            disconnectedAtEpochMs: 1_500,
            reason: 'socket-closed',
            expireAtEpochMs: 10_000
        };
        await repository.upsert('ws-session-close-high-water', 'group:ar-eye-hunter:default:owner:session-1', JSON.stringify(state), 10_000);
        const outcome = await readGroupPresenceConnect({
            command: connectCommand(),
            sessionGenerationLifecycle: lifecycle
        });

        expect(outcome).toEqual({ status: 'inactive', sessionId: 'session-1', generationId: 'generation-1' });
        expect(await repository.findEntry('ws-session-close-high-water', 'group:ar-eye-hunter:default:owner:session-1')).toMatchObject({
            value: JSON.stringify(state),
            revision: 0,
            expireAtTimestamp: 10_000
        });
    });

    it('returns original generation facts and the exact lifecycle predecessor for later compute', async () => {
        const lifecycle = createWsSessionGenerationLifecycleService(new FakeRuntimeStateRepository());
        const outcome = await readGroupPresenceConnect({
            command: connectCommand(),
            sessionGenerationLifecycle: lifecycle
        });

        expect(outcome).toEqual({
            status: 'active',
            facts: {
                scope: { kind: 'group', applicationId: 'ar-eye-hunter', workspaceId: 'default', principalId: 'owner' },
                sessionId: 'session-1',
                generationId: 'generation-1',
                generationStartedAtEpochMs: 1_000
            },
            lifecycleRead: {
                identity: {
                    scope: { kind: 'group', applicationId: 'ar-eye-hunter', workspaceId: 'default', principalId: 'owner' },
                    sessionId: 'session-1'
                },
                key: 'group:ar-eye-hunter:default:owner:session-1',
                revision: null,
                persistedExpireAtEpochMs: null,
                state: null
            }
        });
    });
});

function connectCommand(): GroupStateMutationCommand {
    return {
        authorityProof: null,
        descriptor: null,
        command: {
            operation: 'connectPresence',
            aggregateRef: {
                applicationId: 'ar-eye-hunter',
                workspaceId: 'default',
                groupId: 'group-1'
            },
            commandId: 'connect-command',
            requestId: 'connect-request',
            sessionId: 'session-1',
            input: {
                principalId: 'owner',
                generationId: 'generation-1',
                connectedAtEpochMs: 1_000,
                lastHeartbeatAtEpochMs: 1_000,
                expiresAtEpochMs: 61_000,
                actorPrincipalId: 'owner',
                actorSessionId: 'session-1',
                reason: null,
                traceId: null
            }
        },
        facts: {
            nowEpochMs: 2_000,
            expireAtEpochMs: 604_802_000,
            serviceId: 'server-1',
            eventId: 'event-1',
            commandHash: 'sha256:command',
            attemptCount: 1,
            resolvedJoinCode: null,
            joinCodeVerifier: null,
            internalAuthority: 'none',
            authenticatedAuthority: { principalId: 'owner', sessionId: 'session-1' }
        }
    };
}
