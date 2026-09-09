import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { ALWorkHandler } from '@shared/alm/work/al-work-handler.ts';
import type { ALWorkClaim, ALWorkOutcome, ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { describe, expect, it } from 'vitest';
import { newWorkEntry } from './al-work-test-entries.ts';

describe('ALWorkHandler', () => {
    it('runs one batch per wake, releases each claim once, and never awaits delivery on committed()', async () => {
        const released: string[] = [];
        const port = fakePort({
            claims: ['w-1', 'w-2'],
            onRelease: (claim, outcome) => released.push(`${claim.entry.key.contextId}:${outcome.status}`)
        });
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'test-worker',
            port,
            queueEngine: engine,
            ownsQueueEngine: true,
            clock: { nowMs: () => 1_000 },
            pageSize: 16,
            selectReady: async (p, size) => ({
                claims: await p.claim({ maxCount: size, observedEntries: undefined }),
                nextReadyAtMs: undefined
            }),
            runClaim: async (claim) => claim.entry.key.contextId === 'w-2' ? { status: 'retry' } : { status: 'completed' },
            diagnostics: undefined
        });
        await handler.ready();
        expect(released).toEqual(['w-1:completed', 'w-2:retry']);

        const before = Date.now();
        handler.committed();
        expect(Date.now() - before).toBeLessThan(5);
        handler.dispose();
    });

    it('classifies thrown errors: corruption rejects, other errors retry, retained results settle later', async () => {
        const released: string[] = [];
        const port = fakePort({
            claims: ['c-1', 'c-2', 'c-3'],
            onRelease: (claim, outcome) => released.push(`${claim.entry.key.contextId}:${outcome.status}`)
        });
        const engine = createEngine();
        const handler = new ALWorkHandler({
            workerId: 'test-worker',
            port,
            queueEngine: engine,
            ownsQueueEngine: true,
            clock: { nowMs: () => 1_000 },
            pageSize: 16,
            selectReady: async (p, size) => ({
                claims: await p.claim({ maxCount: size, observedEntries: undefined }),
                nextReadyAtMs: undefined
            }),
            runClaim: async (claim) => {
                switch (claim.entry.key.contextId) {
                    case 'c-1':
                        throw new ALAdmissionCorruptionError('k', new TypeError('x'));
                    case 'c-2':
                        throw new Error('transient');
                    default:
                        return { status: 'retained', settled: Promise.resolve({ status: 'completed' }) };
                }
            },
            diagnostics: undefined
        });

        await handler.ready();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(released).toEqual(['c-1:non-retryable', 'c-2:retry', 'c-3:completed']);
        handler.dispose();
    });
});

function createEngine(): InboxOutboxEngine {
    return new InboxOutboxEngine();
}

interface FakeALWorkPortInput {
    readonly claims: readonly string[];
    readonly onRelease: (claim: ALWorkClaim, outcome: ALWorkOutcome) => void;
}

function fakePort(input: FakeALWorkPortInput): ALWorkQueuePort {
    const pending = input.claims.map((effectId) => toFakeALWorkClaim(effectId));
    return {
        workTypes: new Set(['AL_TEST']),
        retainIfAbsent: async (entry) => entry,
        readPage: async () => ({ entries: [], nextCursor: null }),
        claim: async ({ maxCount }) => pending.splice(0, maxCount),
        finalizeExhausted: async () => [],
        release: async (claim, outcome) => {
            input.onRelease(claim, outcome);
        },
        peekNextReadyAt: async () => undefined,
        readEntry: async () => undefined
    };
}

function toFakeALWorkClaim(effectId: string): ALWorkClaim {
    return { entry: newWorkEntry('AL_TEST', effectId), attempts: 0, leaseUntilMs: 0 };
}
