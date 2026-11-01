import { Temporal } from '@js-temporal/polyfill';
import { AL_MESSAGE_ENVELOPE_VERSION } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { requireEpoch, requireExactKeys, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import { decodeMatchmakingScope } from '@shared/api/matchmaking/matchmaking-request.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { computeAppOutboxInsert, type AppOutboxInsert } from '../app-outbox/app-outbox-insert.ts';
import { AppOutboxType } from '../app-outbox/app-outbox-type.ts';
import { groupStateScopeStorageKey } from '../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { computeSha256CanonicalJson } from '../protocol/canonical-json.ts';
import type { MatchmakingPool } from './matchmaking-pool.ts';

export interface MatchmakingDeadline {
    readonly scope: StateScope;
    readonly deadlineId: string;
    readonly dueAtEpochMs: number;
}

export interface MatchmakingDeadlinesInput {
    readonly before: MatchmakingPool;
    readonly after: MatchmakingPool;
    readonly createdAtEpochMs: number;
    readonly retentionMs: number;
    readonly serviceId: string;
    readonly traceId: string;
}

export function decodeMatchmakingDeadline(value: unknown): MatchmakingDeadline {
    const record = requireRecord(value, 'Matchmaking deadline');
    requireExactKeys(record, ['scope', 'deadlineId', 'dueAtEpochMs'], 'Matchmaking deadline');
    requireString(record.deadlineId, 'Matchmaking deadline identity');
    requireEpoch(record.dueAtEpochMs, 'Matchmaking deadline time');
    if (!/^[a-f0-9]{64}$/.test(record.deadlineId)) {
        throw new TypeError('Matchmaking deadline identity is invalid');
    }
    return {
        scope: decodeMatchmakingScope(record.scope),
        deadlineId: record.deadlineId,
        dueAtEpochMs: record.dueAtEpochMs
    };
}

/** Timers are inserted with the pool CAS; replay and confirmation never schedule the same generation again. */
export function computeMatchmakingDeadlines(input: MatchmakingDeadlinesInput): readonly AppOutboxInsert[] {
    const previous = new Set(poolDeadlines(input.before).map((deadline) => deadline.deadlineId));
    return poolDeadlines(input.after).filter((deadline) => !previous.has(deadline.deadlineId))
        .map((deadline) => deadlineInsert(input, deadline));
}

function poolDeadlines(pool: MatchmakingPool): readonly MatchmakingDeadline[] {
    return [
        ...pool.searching.map((search) => ({
            scope: pool.scope,
            deadlineId: computeSha256CanonicalJson({
                scope: pool.scope,
                kind: 'search',
                principalId: search.principalId,
                searchId: search.searchId,
                createdAtEpochMs: search.createdAtEpochMs
            }),
            dueAtEpochMs: search.expiresAtEpochMs
        })),
        ...pool.proposals.map((proposal) => ({
            scope: pool.scope,
            deadlineId: computeSha256CanonicalJson({
                roomRef: proposal.roomRef,
                kind: 'confirmation',
                participants: proposal.participants.map((player) => ({
                    principalId: player.principalId,
                    searchId: player.searchId,
                    createdAtEpochMs: player.createdAtEpochMs
                })),
                createdAtEpochMs: proposal.createdAtEpochMs
            }),
            dueAtEpochMs: proposal.expiresAtEpochMs
        }))
    ];
}

function deadlineInsert(input: MatchmakingDeadlinesInput, deadline: MatchmakingDeadline): AppOutboxInsert {
    const route = toAppQueueKey({
        topicId: 'matchmaking.deadline',
        resourceId: deadline.deadlineId,
        contextId: groupStateScopeStorageKey(deadline.scope)
    });
    const message = decodePersistedALMessageValue({
        id: {
            v: AL_MESSAGE_ENVELOPE_VERSION,
            msgId: route.resourceId,
            ts: input.createdAtEpochMs,
            senderId: input.serviceId,
            traceId: input.traceId
        },
        route,
        constraints: { expiresAtMs: deadline.dueAtEpochMs + input.retentionMs },
        delivery: { ownership: 'exclusive', reliability: 'at-least-once', ack: 'none' },
        payload: {
            typeId: AppOutboxType.MATCHMAKING_DEADLINE,
            contentType: 'application/json',
            resource: JSON.stringify(deadline)
        },
        audit: { createdBy: input.serviceId, createdTs: input.createdAtEpochMs }
    });
    return computeAppOutboxInsert({
        ...QueueBoxUtilities.toResourceEntryFromMsg(
            message,
            EnqueuedType.APP_OUTBOX,
            Temporal.Instant.fromEpochMilliseconds(input.createdAtEpochMs)
        ),
        dequeueAudit: { attempts: 0, nextTs: Temporal.Instant.fromEpochMilliseconds(deadline.dueAtEpochMs) }
    });
}

export interface InstallMatchmakingDeadlineInput {
    readonly outboxQueueReader: OutboxQueueReader;
    readonly enqueue: (command: MatchmakingDeadline, traceId: string) => Promise<void>;
    readonly nowEpochMs: () => number;
}

export function installMatchmakingDeadline(input: InstallMatchmakingDeadlineInput): void {
    input.outboxQueueReader.onOutboxMessageDo(AppOutboxType.MATCHMAKING_DEADLINE, {
        onMessage: async (message) => {
            const deadline = decodeMatchmakingDeadline(JSON.parse(message.payload.resource));
            const expected = toAppQueueKey({
                topicId: 'matchmaking.deadline',
                resourceId: deadline.deadlineId,
                contextId: groupStateScopeStorageKey(deadline.scope)
            });
            if (
                message.route.topicId !== 'matchmaking.deadline' || message.route.resourceId !== expected.resourceId ||
                message.route.contextId !== expected.contextId ||
                deadline.dueAtEpochMs <= message.id.ts
            ) {
                throw new TypeError('Matchmaking deadline envelope identity differs');
            }
            if (input.nowEpochMs() < deadline.dueAtEpochMs) {
                throw new Error('Matchmaking deadline is not due');
            }
            await input.enqueue(deadline, message.id.traceId);
        }
    });
}
