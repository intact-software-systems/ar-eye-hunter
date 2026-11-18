import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { isGroupActive } from '@shared/api/group-client-views.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { readBrowserServerExpiryEpochMs } from '../../connection/server-clock/browser-server-clock-session.ts';

import { ApiHttpError } from '../../api/http-error.ts';
import { isRetryableApiViewFailure } from '../../api/read-api-view.ts';
import type { ApiMiddleware } from '../../rallar-connection-facade.ts';
import { readStateGroupSnapshot } from '../../state-read/point-read.ts';
import { requireOwnWsConnectionGenerationId } from '../require-own-ws-connection-generation-id.ts';
import type { GroupRef, GroupSnapshot } from '../room-group-state-translation.ts';
import type { StateGroupWorkflowValue } from '../room-group-state-workflows.ts';
import { readSummarisedRoomPresence } from '../room-presence.ts';
import type { RoomSessionFence } from '../room-session-fence.ts';

/** One restore attempt is owned by the selected room, its socket epoch and its session. */
export interface PresenceRestore {
    readonly room: GroupRef;
    readonly scope: StateScope;
    readonly epoch: number;
    readonly fence: RoomSessionFence;
    readonly context: ApiMiddleware;
}

export interface PresenceReconnect extends PresenceRestore {
    readonly expiresAtEpochMs: number;
    readonly generationId: string;
    readonly connectionGenerationId: string;
    readonly command: Command<StateGroupWorkflowValue>;
}

interface ObservedRoomPresence {
    readonly connectionGenerationId: string | undefined;
    readonly room: GroupRef;
    readonly session: AuthSession;
    readonly snapshot: GroupSnapshot | undefined;
    readonly nowEpochMs: number;
}

interface RestoreSnapshot {
    readonly connectionGenerationId: string;
    readonly snapshot: GroupSnapshot;
}

/** The previous immutable request has resolved, but a new lease is needed before arrival. */
export class RestoredPresenceExpiredError extends TypeError {}

export async function readRestoreSnapshot(
    restore: PresenceRestore,
    assertCurrent: () => void
): Promise<RestoreSnapshot> {
    return await new Command(async (signal) => {
        assertCurrent();
        const connectionGenerationId = await requireOwnWsConnectionGenerationId(restore.context, signal);
        assertCurrent();
        const { snapshot } = await readStateGroupSnapshot(restore.room.groupId, restore.scope, {
            authSession: restore.fence.session,
            signal
        });
        return { connectionGenerationId, snapshot };
    }, {
        maxAttempts: restore.context.middleware.heartbeat.groupPresence ? 1 : 3,
        timeoutMs: restore.context.middleware.heartbeat.groupPresence?.requestTimeoutMs ?? 15000,
        shouldRetry: (error) => isRetryableApiViewFailure(toError(error))
    })
        .run();
}

export async function sendPresenceReconnect(
    reconnect: PresenceReconnect,
    assertCurrent: () => void
): Promise<GroupSnapshot> {
    const result = await reconnect.command.run().catch((error) => {
        if (
            error instanceof ApiHttpError && error.status === 400 &&
            reconnect.expiresAtEpochMs <= readBrowserServerExpiryEpochMs(reconnect.context.serverTime)
        ) {
            throw new RestoredPresenceExpiredError('Expired presence request was definitively rejected.');
        }
        throw error;
    });
    assertCurrent();
    if (!result || !isSameGroupRef(reconnect.room, result.group)) {
        throw new Error('Selected room did not confirm presence on the replacement socket.');
    }
    if (reconnect.expiresAtEpochMs <= readBrowserServerExpiryEpochMs(reconnect.context.serverTime)) {
        throw new RestoredPresenceExpiredError('Presence request resolved after its lease expired.');
    }
    return await readSummarisedRoomPresence({
        snapshot: result,
        fence: { session: reconnect.fence.session, assertCurrent },
        context: reconnect.context,
        options: { timeoutMs: reconnect.context.middleware.heartbeat.groupPresence?.requestTimeoutMs ?? 15000 },
        isSummarised: (snapshot) =>
            isConfirmedPresence(reconnect, snapshot, readBrowserServerExpiryEpochMs(reconnect.context.serverTime))
    });
}

export function needsPresenceRestore(
    { room, session, snapshot, nowEpochMs, connectionGenerationId }: ObservedRoomPresence
): boolean {
    if (!snapshot) {
        return true;
    }
    if (!isSameGroupRef(room, snapshot.group) || !isActiveMember(snapshot, session)) {
        return false;
    }
    return !snapshot.activeSessions.some((row) =>
        row.principalId === session.clientId && row.sessionId === session.sessionId &&
        row.connectionGenerationId === connectionGenerationId && row.expiresAtEpochMs > nowEpochMs
    );
}

export function isActiveMember(snapshot: GroupSnapshot, session: AuthSession): boolean {
    return isGroupActive(snapshot) &&
        snapshot.members.some((member) => member.principalId === session.clientId && member.status === 'active');
}

export function isConfirmedPresence(
    reconnect: PresenceReconnect,
    snapshot: GroupSnapshot,
    nowEpochMs: number
): boolean {
    const { session } = reconnect.fence;
    return isSameGroupRef(reconnect.room, snapshot.group) &&
        snapshot.activeSessions.some((row) =>
            row.principalId === session.clientId && row.sessionId === session.sessionId &&
            row.generationId === reconnect.generationId &&
            row.connectionGenerationId === reconnect.connectionGenerationId && row.expiresAtEpochMs > nowEpochMs
        );
}
