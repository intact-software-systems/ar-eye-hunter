import { expect, it } from 'vitest';
import { AUTH_OUTPUTS, executeRecipeSegment } from './api-v1-recipe-causal-prerequisite-fixture.ts';

const slots = ['semifinal-1', 'semifinal-2', 'final'];

function observeResolution(index: number, winner: string) {
    let observedScheduled = false;
    return executeRecipeSegment({
        recipe: 'api-v1-tournaments', start: `match${index}resolved`, end: `match${index}winnerAssertion`,
        outputs: { ...AUTH_OUTPUTS, charlieClientId: 'charlie' },
        fetch: async () => {
            const resolved = observedScheduled;
            observedScheduled = true;
            const matches = slots.map((slot, position) => {
                if (position < index || position === index && resolved) {
                    return { slot, status: 'complete', resolution: { winnerPrincipalId: position === index ? winner : 'alice' } };
                }
                return { slot, status: position === index ? 'scheduled' : 'waiting', resolution: null };
            });
            return Response.json({ tournament: { status: index === 2 && resolved ? 'complete' : 'active', matches } });
        }
    });
}

it.each([[0, 'alice'], [1, 'charlie'], [2, 'alice']] as const)(
    'observes the deadline worker resolving match %i before checking the winner', async (index, winner) => {
        const report = await observeResolution(index, winner);
        expect(report.summary.failure).toBe(0);
        expect(report.resultsByName[`match${index}winnerAssertion`][0].status).toBe('SUCCESS');
    }
);

it('rejects a completed semifinal awarded to the wrong player', async () => {
    const report = await observeResolution(1, 'dana');
    expect(report.resultsByName.match1winnerAssertion[0].status).toBe('FAILURE');
});
