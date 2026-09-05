import { AppTopics } from '@shared/api/api-config.ts';
import { computeStateSnapshotPages, STATE_SNAPSHOT_LIMITS, type StateSnapshotPublication } from '@shared/api/state-snapshot-page.ts';
import { StateSnapshotAssembly } from '@shared/services/state-snapshot-assembly.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

const scope = { applicationId: 'app', workspaceId: 'workspace' };

describe('bounded state snapshot publication and assembly', () => {
    afterEach(() => vi.useRealTimers());

    it('preserves a large snapshot and every recipient using independently bounded unordered envelopes', () => {
        const publication = createPublication(300);
        const messages = computeStateSnapshotPages(publication).right!;
        expect(messages.length).toBeGreaterThan(2);
        expect(new Set(messages.map((message) => message.id.msgId)).size).toBe(messages.length);
        const recipients = new Set<string>();
        for (const message of messages) {
            expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThanOrEqual(128 * 1024);
            expect(new TextEncoder().encode(message.payload.resource).length).toBeLessThanOrEqual(64 * 1024);
            expect(message.ordering).toBeUndefined();
            if (message.targets?.mode !== 'broadcast') {
                throw new Error('Expected a frozen broadcast audience');
            }
            expect(message.targets.recipientPeerIds!.length).toBeLessThanOrEqual(256);
            message.targets.recipientPeerIds!.forEach((peer) => recipients.add(peer));
        }
        expect([...recipients]).toEqual(Array.from({ length: 300 }, (_, index) => `peer-${index}`));
        const assembly = new StateSnapshotAssembly();
        const results = [...messages].reverse().map((message) => assembly.accept({ message, scope, nowMs: 1000 }));
        const completed = results.flatMap((result) => result.right?.kind === 'complete' ? [result.right.snapshot] : []);
        expect(completed).toHaveLength(1);
        expect(completed[0].resource).toBe(publication.resource);
        assembly.dispose();
    });

    it('keeps missing pages out of authority and makes exact duplicates idempotent', () => {
        const messages = computeStateSnapshotPages(createPublication(1)).right!;
        const assembly = new StateSnapshotAssembly();
        expect(assembly.accept({ message: messages[0], scope, nowMs: 1000 }).right?.kind).toBe('pending');
        expect(assembly.accept({ message: messages[0], scope, nowMs: 1001 }).right?.kind).toBe('pending');
        expect(messages.slice(1).map((message) => assembly.accept({ message, scope, nowMs: 1002 }).right?.kind))
            .toContain('complete');
        expect(assembly.accept({ message: messages[0], scope, nowMs: 1003 }).right?.kind).toBe('duplicate');
        assembly.dispose();
    });

    it('cancels conflicting pages and rejects foreign scope before retaining state', () => {
        const messages = computeStateSnapshotPages(createPublication(1)).right!;
        const assembly = new StateSnapshotAssembly();
        expect(assembly.accept({ message: messages[0], scope: { ...scope, workspaceId: 'foreign' }, nowMs: 1000 }).left?.code)
            .toBe('unauthorized');
        assembly.accept({ message: messages[0], scope, nowMs: 1000 });
        const page = JSON.parse(messages[0].payload.resource);
        const conflict = { ...messages[0], payload: { ...messages[0].payload, resource: JSON.stringify({ ...page, chunk: 'other' }) } };
        expect(assembly.accept({ message: conflict, scope, nowMs: 1001 }).left?.code).toBe('malformed');
        expect(messages.slice(1).every((message) => assembly.accept({ message, scope, nowMs: 1002 }).left)).toBe(true);
        assembly.dispose();
    });

    it('rejects a conflicting duplicate even after the complete snapshot was emitted', () => {
        const messages = computeStateSnapshotPages(createPublication(1)).right!;
        const assembly = new StateSnapshotAssembly();
        for (const message of messages) {
            assembly.accept({ message, scope, nowMs: 1000 });
        }
        const page = JSON.parse(messages[0].payload.resource);
        const conflict = { ...messages[0], payload: { ...messages[0].payload, resource: JSON.stringify({ ...page, chunk: 'changed after completion' }) } };
        expect(assembly.accept({ message: conflict, scope, nowMs: 1001 }).left?.code).toBe('malformed');
        expect(assembly.accept({ message: messages[0], scope, nowMs: 1002 }).left?.code).toBe('malformed');
        assembly.dispose();
    });

    it('bounds in-flight transfer count without discarding an admitted unfinished snapshot', () => {
        const assembly = new StateSnapshotAssembly();
        const transfers = Array.from({ length: 9 }, (_, index) => {
            const publication = createPublication(1);
            return computeStateSnapshotPages({
                ...publication,
                envelope: { ...publication.envelope, id: { ...publication.envelope.id, msgId: `transfer-${index}` } }
            }).right!;
        });
        for (const messages of transfers.slice(0, 8)) {
            expect(assembly.accept({ message: messages[0], scope, nowMs: 1000 }).right?.kind).toBe('pending');
        }
        expect(assembly.accept({ message: transfers[8][0], scope, nowMs: 1000 }).left?.code).toBe('oversized');
        expect(transfers[0].slice(1).map((message) => assembly.accept({ message, scope, nowMs: 1001 }).right?.kind))
            .toContain('complete');
        expect(assembly.accept({ message: transfers[8][0], scope, nowMs: 1002 }).right?.kind).toBe('pending');
        assembly.dispose();
    });

    it('reserves the declared aggregate size before accepting additional partial transfers', () => {
        const assembly = new StateSnapshotAssembly();
        const outcomes = Array.from({ length: 3 }, (_, index) => {
            const publication = createPublication(1);
            const message = computeStateSnapshotPages({
                ...publication,
                envelope: { ...publication.envelope, id: { ...publication.envelope.id, msgId: `aggregate-${index}` } }
            }).right![0];
            const page = JSON.parse(message.payload.resource);
            return assembly.accept({
                message: {
                    ...message,
                    payload: { ...message.payload, resource: JSON.stringify({ ...page, totalBytes: STATE_SNAPSHOT_LIMITS.snapshotBytes }) }
                },
                scope,
                nowMs: 1000
            });
        });
        expect(outcomes.map((result) => result.right?.kind ?? result.left?.code)).toEqual(['pending', 'pending', 'oversized']);
        assembly.clear();
        expect(assembly.accept({ message: computeStateSnapshotPages(createPublication(1)).right![0], scope, nowMs: 1001 }).right?.kind)
            .toBe('pending');
        assembly.dispose();
    });

    it('rejects impossible page counts and publications exceeding the byte ceiling', () => {
        const publication = createPublication(1);
        expect(
            computeStateSnapshotPages({ ...publication, resource: JSON.stringify('x'.repeat(STATE_SNAPSHOT_LIMITS.snapshotBytes)) })
                .left?.code
        ).toBe('oversized');
        const message = computeStateSnapshotPages(publication).right![0];
        const page = JSON.parse(message.payload.resource);
        const assembly = new StateSnapshotAssembly();
        expect(
            assembly.accept({ message: { ...message, payload: { ...message.payload, resource: JSON.stringify({ ...page, count: 257 }) } }, scope, nowMs: 1000 })
                .left?.code
        ).toBe('malformed');
        assembly.dispose();
    });

    it('expires partial transfers and cancels all retained pages on disposal', () => {
        vi.useFakeTimers();
        const messages = computeStateSnapshotPages(createPublication(1)).right!;
        const assembly = new StateSnapshotAssembly();
        assembly.accept({ message: messages[0], scope, nowMs: 1000 });
        vi.advanceTimersByTime(30_001);
        expect(assembly.accept({ message: messages[1], scope, nowMs: 31_001 }).left?.code).toBe('malformed');
        assembly.dispose();
        expect(assembly.accept({ message: messages[0], scope, nowMs: 1000 }).left?.code).toBe('malformed');
    });
});

function createPublication(recipientCount: number): StateSnapshotPublication {
    return Object.freeze({
        scope: Object.freeze({ ...scope, kind: 'group' as const, resourceId: 'room' }),
        revision: 'group=1;presence=2',
        resource: JSON.stringify({ members: Array.from({ length: 300 }, (_, index) => ({ index, name: 'Member'.repeat(100) })) }),
        envelope: Object.freeze({
            id: Object.freeze({ v: 2 as const, msgId: 'snapshot-1', ts: 1000, senderId: 'rallar-server' }),
            route: Object.freeze({ topicId: AppTopics.groupStateSnapshot, contextId: 'room', resourceId: 'snapshot' }),
            targets: Object.freeze({
                mode: 'broadcast' as const,
                scope: 'room' as const,
                groupRef: Object.freeze({ ...scope, groupId: 'room' }),
                recipientPeerIds: Object.freeze(Array.from({ length: recipientCount }, (_, index) => `peer-${index}`))
            }),
            constraints: Object.freeze({ expiresAtMs: 100_000 }),
            delivery: Object.freeze({ reliability: 'at-least-once' as const, ack: 'none' as const }),
            audit: Object.freeze({ createdBy: 'rallar-server', createdTs: 1000 })
        })
    });
}
