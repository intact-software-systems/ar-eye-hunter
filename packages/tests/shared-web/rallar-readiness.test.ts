import { evaluateRallarReadinessExpectation, normalizeRallarReadinessExpectation } from '@shared-web/browser/rallar.ts';
import { describe, expect, it } from 'vitest';

describe('Rallar readiness expectations', () => {
    it('treats one active local session as ready for min one', () => {
        const result = evaluateRallarReadinessExpectation(
            ['session-local'],
            normalizeRallarReadinessExpectation({ min: 1 })
        );

        expect(result).toMatchObject({
            status: 'ready',
            observedCount: 1,
            expectedCount: 1,
            missingSessionIds: [],
            extraSessionIds: []
        });
    });

    it('reports partial when exact count is not reached', () => {
        const result = evaluateRallarReadinessExpectation(
            ['session-local'],
            normalizeRallarReadinessExpectation({ exact: 2 })
        );

        expect(result).toMatchObject({
            status: 'partial',
            observedCount: 1,
            expectedCount: 2
        });
    });

    it('reports over-capacity when max is exceeded', () => {
        const result = evaluateRallarReadinessExpectation(
            ['a', 'b', 'c'],
            normalizeRallarReadinessExpectation({ min: 1, max: 2 })
        );

        expect(result).toMatchObject({
            status: 'over-capacity',
            observedCount: 3,
            expectedCount: 1,
            extraSessionIds: ['c']
        });
    });

    it('waits for expected session ids and allows extras by default', () => {
        const result = evaluateRallarReadinessExpectation(
            ['director', 'player', 'spectator'],
            normalizeRallarReadinessExpectation({
                sessionIds: ['director', 'player']
            })
        );

        expect(result).toMatchObject({
            status: 'ready',
            observedCount: 3,
            expectedCount: 2,
            missingSessionIds: [],
            extraSessionIds: ['spectator']
        });
    });

    it('reports over-capacity for strict session id expectations', () => {
        const result = evaluateRallarReadinessExpectation(
            ['director', 'player', 'spectator'],
            normalizeRallarReadinessExpectation({
                sessionIds: ['director', 'player'],
                allowExtras: false
            })
        );

        expect(result).toMatchObject({
            status: 'over-capacity',
            observedCount: 3,
            expectedCount: 2,
            extraSessionIds: ['spectator']
        });
    });

    it('normalizes exact zero as an empty satisfied expectation', () => {
        const result = evaluateRallarReadinessExpectation(
            [],
            normalizeRallarReadinessExpectation({ exact: 0 })
        );

        expect(result).toMatchObject({
            status: 'empty',
            observedCount: 0,
            expectedCount: 0
        });
    });
});
