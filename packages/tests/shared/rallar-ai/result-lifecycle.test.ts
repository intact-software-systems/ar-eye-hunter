import {
    assertRallarAiResultLifecycleTransition,
    createRallarAiAcceptedResultTracker,
    createRallarAiMockProvider,
    summarizeRallarAiReplayLog,
    transitionRallarAiResultLifecycle
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';
import { GAME_EVENT_SCHEMA_FIXTURE } from './game-event-schema-fixture.ts';

describe('RallarAI result lifecycle', () => {
    it('validates result lifecycle transitions', () => {
        expect(() => assertRallarAiResultLifecycleTransition('accepted', 'draft')).toThrow('Invalid RallarAI lifecycle transition');
        expect(() => assertRallarAiResultLifecycleTransition('proposed', 'accepted')).not.toThrow();
    });

    it('applies accepted proposal envelopes once and summarizes replay metadata', async () => {
        const provider = createRallarAiMockProvider({
            value: { kind: 'spawn', amount: 1 }
        });
        const result = await provider.generateJson<{ kind: 'spawn'; amount: number; }>({
            requestId: 'request-approval',
            schemaId: 'game-event',
            schemaVersion: '1',
            schema: GAME_EVENT_SCHEMA_FIXTURE,
            prompt: 'Generate a spawn.',
            dedupeKey: 'room:1:turn:7'
        });
        const proposed = transitionRallarAiResultLifecycle(result, 'proposed');
        const accepted = transitionRallarAiResultLifecycle(proposed, 'accepted');
        const tracker = createRallarAiAcceptedResultTracker<typeof accepted.value>();
        const applied: Array<typeof accepted.value> = [];

        await expect(
            tracker.acceptOnce(proposed, (proposal) => {
                applied.push(proposal.value);
            })
        ).resolves.toEqual({
            applied: false,
            dedupeId: 'room:1:turn:7',
            reason: 'not-accepted'
        });
        await expect(
            tracker.acceptOnce(accepted, (proposal) => {
                applied.push(proposal.value);
            })
        ).resolves.toEqual({
            applied: true,
            dedupeId: 'room:1:turn:7'
        });
        await expect(
            tracker.acceptOnce(accepted, (proposal) => {
                applied.push(proposal.value);
            })
        ).resolves.toEqual({
            applied: false,
            dedupeId: 'room:1:turn:7',
            reason: 'duplicate'
        });

        expect(applied).toEqual([{ kind: 'spawn', amount: 1 }]);
        expect(tracker.snapshot()).toEqual(['room:1:turn:7']);
        expect(summarizeRallarAiReplayLog([accepted, accepted])).toEqual(
            expect.objectContaining({
                total: 2,
                accepted: 2,
                validationFailed: 0,
                duplicateDedupeIds: ['room:1:turn:7']
            })
        );
    });
});
