import { expect } from 'vitest';

import { createRelicGame, toRelicRoomGroupRef } from '@relic-hunters/mod.ts';
import {
    captureRelicGameCommand,
    RELIC_ROOM_DATA_BINDING,
    RelicGameMutationService
} from '@relic-hunters/server/relic-game-mutation-service.ts';
import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import { RoomOwnedAppData } from '@shared-server/app-data/room-owned-app-data.ts';
import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { toGroupMutationAttemptFacts } from '@shared-server/rallar-system/group-state/mutation/to-group-mutation-attempt-facts.ts';
import { computeGroupPresenceSummary } from '@shared-server/rallar-system/group-state/presence/compute-group-presence-summary.ts';

import {
    commitMutation,
    createRetentionDatabaseFixture,
    prepareMutation,
    requireMutationWrite
} from '../shared-server/rallar-system/group-state/retention/group-retention-database-fixture.ts';

/** The trace every prepared Relic attempt carries, as its queued command's envelope would. */
export const RELIC_FIXTURE_TRACE_ID = 'trace-relic-game-database-fixture';

export async function createGameFixture(gameId = 'expedition-1') {
    const fixture = await createRetentionDatabaseFixture();
    const ref = toRelicRoomGroupRef(gameId);
    const { computed } = await prepareMutation(
        fixture,
        mutationDescriptor({
            operation: 'createGroup',
            scope: ref,
            groupId: ref.groupId,
            request: {
                requestId: 'create-expedition',
                groupId: ref.groupId,
                displayName: 'Expedition',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'owner',
                actorPrincipalId: 'owner',
                retention: { mode: 'temporary', reconnectGraceMs: 600_000 }
            }
        })
    );
    await commitMutation(fixture, requireMutationWrite(computed));
    const data = new RoomOwnedAppData(new PSqlAppDataRepository(fixture.storage.sql), [RELIC_ROOM_DATA_BINDING]);
    const service = new RelicGameMutationService({
        groups: fixture.repository,
        sessions: new AuthSessionPersistence(fixture.runtime),
        data
    }, { now: () => fixture.nowEpochMs });
    const command = {
        operation: 'ensure',
        gameId: ref.groupId,
        requestId: 'initialize-owner',
        actor: {
            clientId: fixture.owner.clientId,
            sessionId: fixture.owner.sessionId,
            issuedAtEpochMs: fixture.owner.issuedAtEpochMs
        },
        authorization: 'group-policy',
        move: null
    } satisfies RelicGameMutationService.Command;
    return Object.assign(fixture, { ref, data, service, command });
}

export async function prepareGameWrite(
    fixture: Awaited<ReturnType<typeof createGameFixture>>,
    command: RelicGameMutationService.CommandInput,
    initial: ReturnType<typeof createRelicGame> | null
) {
    const ingress = fixture.service.capture(captureRelicGameCommand(command), initial, 'default-qbox-server');
    const read = await fixture.service.read(ingress);
    const attempt = { ...read, traceId: RELIC_FIXTURE_TRACE_ID };
    const computed = fixture.service.compute(attempt);
    expect(fixture.service.validate(attempt, computed)).toEqual([]);
    return { ingress, read, computed };
}

export async function refreshGamePresence(fixture: Awaited<ReturnType<typeof createGameFixture>>): Promise<void> {
    const observed = await fixture.repository.readPresenceSummaryEntries(fixture.ref);
    if (observed.group === undefined || observed.current === undefined) {
        throw new Error('Expected the initialized room and presence summary');
    }
    const computed = computeGroupPresenceSummary({
        ref: fixture.ref,
        nowEpochMs: fixture.nowEpochMs,
        read: {
            group: observed.group,
            members: observed.members,
            admissions: observed.admissions,
            presenceSessions: observed.presenceSessions,
            current: observed.current
        }
    });
    if (computed.outcome === 'write' && computed.operation === 'update') {
        await fixture.repository.updatePresenceSummary(computed.summary, computed.expectedRevision);
    }
}

export async function connectGameSession(
    fixture: Awaited<ReturnType<typeof createGameFixture>>,
    session: typeof fixture.owner
): Promise<void> {
    await new AuthSessionPersistence(fixture.runtime).putSession(session);
    if (session.clientId !== fixture.owner.clientId) {
        const membership = await prepareMutation(
            fixture,
            mutationDescriptor({
                operation: 'upsertMember',
                scope: fixture.ref,
                groupId: fixture.ref.groupId,
                targetPrincipalId: session.clientId,
                request: { requestId: `member-${session.sessionId}`, status: 'active', actorPrincipalId: fixture.owner.clientId }
            })
        );
        await commitMutation(fixture, requireMutationWrite(membership.computed));
    }
    const ingress = await fixture.mutations.captureMutationIngress(
        mutationDescriptor({
            operation: 'connectPresence',
            scope: fixture.ref,
            groupId: fixture.ref.groupId,
            sessionId: session.sessionId,
            request: {
                requestId: `connect-${session.sessionId}`,
                principalId: session.clientId,
                generationId: `generation-${session.sessionId}`,
                connectionGenerationId: `connection-${session.sessionId}`,
                connectedAtEpochMs: fixture.nowEpochMs,
                lastHeartbeatAtEpochMs: fixture.nowEpochMs,
                expiresAtEpochMs: fixture.nowEpochMs + 60_000,
                actorPrincipalId: session.clientId
            }
        }),
        session
    );
    const command = {
        ...ingress,
        facts: toGroupMutationAttemptFacts({
            ingressFacts: ingress.facts,
            attemptCount: 1,
            laneNowEpochMs: fixture.nowEpochMs,
            traceId: RELIC_FIXTURE_TRACE_ID
        })
    };
    const read = await fixture.mutations.read(command);
    const computed = fixture.mutations.compute(command, read);
    expect(fixture.mutations.validate(command, read, computed)).toEqual([]);
    await commitMutation(fixture, requireMutationWrite(computed));
    await refreshGamePresence(fixture);
}
