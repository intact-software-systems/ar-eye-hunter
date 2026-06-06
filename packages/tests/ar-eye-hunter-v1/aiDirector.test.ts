import {
    createRallarAiAcceptedResultTracker,
    type RallarAiJsonResult,
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';

import {
    materializeAiArenaEvent,
    validateAiDirectorProposalValue,
} from '../../../apps/ar-eye-hunter-v1/src/game/aiDirector.ts';
import {
    createInitialArenaState,
    toArenaSnapshot,
} from '../../../apps/ar-eye-hunter-v1/src/game/simulation.ts';
import type { AiDirectorProposalValue } from '../../../apps/ar-eye-hunter-v1/src/game/types.ts';

describe('AR Eye Hunter AI director', () => {
    it('validates and clamps live chaos proposals', () => {
        const now = 12_000;
        const snapshot = toArenaSnapshot(createInitialArenaState(321, now), 'room-1', now);

        const validation = validateAiDirectorProposalValue({
            event: {
                kind: 'arena-shift',
                intensity: 99,
                durationMs: 999_999,
                headline: 'Everything tilts',
            },
            urgency: 'high',
            reason: 'Push movement pressure.',
        }, snapshot);

        expect(validation.ok).toBe(true);
        if (validation.ok) {
            expect(validation.value.event.intensity).toBe(4);
            expect(validation.value.event.durationMs).toBe(16_000);
            expect(validation.value.urgency).toBe('high');
        }
    });

    it('rejects proposals for unknown target ids', () => {
        const now = 13_000;
        const snapshot = toArenaSnapshot(createInitialArenaState(654, now), 'room-1', now);

        const validation = validateAiDirectorProposalValue({
            event: {
                kind: 'combo-bounty',
                targetId: 'missing-eye',
                headline: 'Impossible bounty',
            },
            urgency: 'medium',
            reason: 'Bad target id.',
        }, snapshot);

        expect(validation.ok).toBe(false);
    });

    it('materializes accepted proposals as arena events', () => {
        const now = 14_000;
        const value: AiDirectorProposalValue = {
            event: {
                kind: 'overdrive-window',
                durationMs: 7_500,
                headline: 'Open season',
            },
            urgency: 'medium',
            reason: 'Reward aggressive play.',
        };

        const event = materializeAiArenaEvent({
            generationId: 'gen-1',
            dedupeKey: 'dedupe-1',
            baseStateRevision: 'rev-1',
            value,
            accepted: true,
            sentAtEpochMs: now,
        }, 4, now);

        expect(event.id).toBe('ai-event:gen-1');
        expect(event.kind).toBe('overdrive-window');
        expect(event.expiresAtEpochMs - event.startsAtEpochMs).toBe(7_500);
    });

    it('dedupes accepted AI results by dedupe key', async () => {
        const tracker = createRallarAiAcceptedResultTracker<AiDirectorProposalValue>();
        const result = fakeResult('gen-1', 'same-dedupe');
        let applyCount = 0;

        const first = await tracker.acceptOnce(result, () => {
            applyCount += 1;
        });
        const second = await tracker.acceptOnce(fakeResult('gen-2', 'same-dedupe'), () => {
            applyCount += 1;
        });

        expect(first.applied).toBe(true);
        expect(second.applied).toBe(false);
        expect(applyCount).toBe(1);
    });
});

function fakeResult(
    generationId: string,
    dedupeKey: string,
): RallarAiJsonResult<AiDirectorProposalValue> {
    return {
        protocolVersion: 1,
        requestId: `request-${generationId}`,
        generationId,
        dedupeKey,
        source: 'mock',
        providerId: 'test',
        modelId: 'test-model',
        schemaId: 'ar-eye-hunter.ai-director-event',
        schemaVersion: '1',
        schemaHash: 'schema',
        promptHash: 'prompt',
        baseStateRevision: 'revision',
        createdAtEpochMs: 1,
        value: {
            event: {
                kind: 'combo-bounty',
                headline: 'Bounty',
            },
            urgency: 'medium',
            reason: 'Test',
        },
        validation: {
            ok: true,
            errors: [],
            issues: [],
        },
        lifecycle: 'accepted',
    };
}
