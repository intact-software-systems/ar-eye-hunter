import { computeMatchmaking } from '@shared-server/rallar-system/matchmaking/compute-matchmaking.ts';
import { computeMatchmakingDeadlines, decodeMatchmakingDeadline } from '@shared-server/rallar-system/matchmaking/matchmaking-deadline.ts';
import type { MatchmakingIntent } from '@shared-server/rallar-system/matchmaking/matchmaking-pool.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { describe, expect, it } from 'vitest';

const scope = { applicationId: 'game', workspaceId: 'default' };
const policy = { players: 2, searchTimeoutMs: 120000, confirmationTimeoutMs: 30000, maxSearching: 256 };

describe('durable matchmaking deadlines', () => {
    it('schedules each new wait exactly once and schedules the shorter confirmation separately', () => {
        const empty = { scope, searching: [], proposals: [] };
        const alice = computeMatchmaking({ pool: empty, policy, nowEpochMs: 1000, command: start('alice') });
        const first = computeMatchmakingDeadlines({
            before: empty,
            after: alice.pool,
            createdAtEpochMs: 1000,
            retentionMs: 600000,
            serviceId: 'test',
            traceId: 'search'
        });
        expect(first).toHaveLength(1);
        expect(first[0]!.entry.dequeueAudit.nextTs?.epochMilliseconds).toBe(121000);
        const message = decodePersistedALMessage(first[0]!.entry.resource);
        expect(decodeMatchmakingDeadline(JSON.parse(message.payload.resource))).toMatchObject({ scope, dueAtEpochMs: 121000 });
        expect(
            computeMatchmakingDeadlines({
                before: alice.pool,
                after: alice.pool,
                createdAtEpochMs: 1001,
                retentionMs: 600000,
                serviceId: 'test',
                traceId: 'repeat'
            })
        ).toEqual([]);
        const bob = computeMatchmaking({ pool: alice.pool, policy, nowEpochMs: 1000, command: start('bob') });
        const confirmation = computeMatchmakingDeadlines({
            before: alice.pool,
            after: bob.pool,
            createdAtEpochMs: 1000,
            retentionMs: 600000,
            serviceId: 'test',
            traceId: 'confirm'
        });
        expect(confirmation).toHaveLength(1);
        expect(confirmation[0]!.entry.dequeueAudit.nextTs?.epochMilliseconds).toBe(31000);
        expect(confirmation[0]!.entry.key.resourceId).not.toBe(first[0]!.entry.key.resourceId);
    });

    it('rejects unscoped or overposted deadline work', () => {
        expect(() => decodeMatchmakingDeadline({ scope, deadlineId: 'a'.repeat(64), dueAtEpochMs: 1000, actor: 'alice' })).toThrow();
        expect(() => decodeMatchmakingDeadline({ scope: { applicationId: 'game' }, deadlineId: 'a'.repeat(64), dueAtEpochMs: 1000 })).toThrow();
    });
});

function start(principalId: string): MatchmakingIntent {
    return {
        action: 'start',
        searchId: principalId,
        principalId,
        sessionId: `session-${principalId}`,
        sessionIssuedAtEpochMs: 1,
        sessionExpiresAtEpochMs: 600000,
        capturedAtEpochMs: 1000
    };
}
