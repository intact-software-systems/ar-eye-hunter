import {
    createRallarAiAcceptedResultTracker,
    type RallarAiJsonResult,
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';

import {
    createAiArenaLayoutRequest,
    createAiDirectorRequest,
    materializeAiArenaEvent,
    validateAiArenaLayoutProposal,
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

    it('validates bounded AI layout proposals before Babylon can render them', () => {
        const validation = validateAiArenaLayoutProposal({
            schema: 'ar-eye-hunter.arena-layout',
            version: '1',
            id: 'ai-layout-1',
            revision: 2,
            name: 'Exit Through Gift Shop Protocol',
            halfSize: 60,
            theme: {
                base: '#020805',
                grid: '#49ff86',
                accent: '#00e5ff',
                warning: '#ff3df2',
                reward: '#ffe66d',
            },
            spawnPoints: [
                [-45, 1.72, -45],
                [45, 1.72, 45],
            ],
            pickupAnchors: [
                { id: 'pickup-a', position: [0, 1, 0] },
                { id: 'pickup-b', position: [14, 1, 0] },
                { id: 'pickup-c', position: [-14, 1, 0] },
            ],
            props: [{
                id: 'cover-a',
                kind: 'cover',
                position: [0, 1, 8],
                size: [4, 2, 2],
                blocksShots: true,
            }],
            signs: [{
                id: 'sign-a',
                title: 'MORALE PATCH',
                detail: 'fun is mandatory and logged',
                position: [0, 3, 57],
                rotationY: Math.PI,
            }],
        });

        expect(validation.ok).toBe(true);
        expect(validation.layout.id).toBe('ai-layout-1');
        expect(validation.layout.halfSize).toBe(60);
        expect(validation.layout.pickupAnchors.length).toBe(3);
    });

    it('requests AI layouts and chaos with the 120m wave-aware FPS context', () => {
        const now = 15_000;
        const state = createInitialArenaState(987, now);
        const layoutRequest = createAiArenaLayoutRequest(state, 'room-1');
        const chaosRequest = createAiDirectorRequest(state, 'room-1');
        const layoutSchema = layoutRequest.schema as {
            properties: { halfSize: { minimum: number; maximum: number } };
        };

        expect(layoutSchema.properties.halfSize.minimum).toBe(32);
        expect(layoutSchema.properties.halfSize.maximum).toBe(72);
        expect(layoutRequest.prompt).toContain('120m x 120m arena');
        expect(layoutRequest.context?.waveNumber).toBe(1);
        expect(layoutRequest.context?.wavePhase).toBe('warmup');
        expect(layoutRequest.context?.hostileCount).toBeGreaterThan(0);
        expect(chaosRequest.prompt).toContain('wave context');
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
