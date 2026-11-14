import { describe, expect, it } from 'vitest';

import { runObservedFamily } from '../../../tests/playwright/rallar-black-box/run-observed-family.ts';

describe('the observed family run', () => {
    const bodyFailure = new Error('the scenario failed');
    const observationFailure = new Error('the observation failed');
    const closeFailure = new Error('the close failed');

    interface Family {
        readonly events: string[];
        readonly run: { close(): Promise<void>; startedRoots: []; };
    }

    function createFamily(closeResult: Error | undefined = undefined): Family {
        const events: string[] = [];
        return {
            events,
            run: {
                startedRoots: [],
                close: async () => {
                    events.push('close');
                    if (closeResult !== undefined) {
                        throw closeResult;
                    }
                }
            }
        };
    }

    function toInput(
        family: Family,
        failures: { readonly body?: Error; readonly observation?: Error; readonly testErrors?: number; }
    ): Parameters<typeof runObservedFamily>[0] {
        return {
            run: family.run,
            testInfo: { errors: Array.from({ length: failures.testErrors ?? 0 }, () => ({})) },
            body: async () => {
                family.events.push('body');
                if (failures.body !== undefined) {
                    throw failures.body;
                }
            },
            observe: async (cellOutcome) => {
                family.events.push(`observe:${cellOutcome}`);
                if (failures.observation !== undefined) {
                    throw failures.observation;
                }
            }
        };
    }

    it('records the observation after the body and before the close', async () => {
        const family = createFamily();

        await runObservedFamily(toInput(family, {}));

        expect(family.events).toEqual(['body', 'observe:passed', 'close']);
    });

    it('records the observation after the body and before the close also when the body throws, and reports the body\'s error', async () => {
        const family = createFamily();

        await expect(runObservedFamily(toInput(family, { body: bodyFailure }))).rejects.toBe(bodyFailure);

        expect(family.events).toEqual(['body', 'observe:failed', 'close']);
    });

    it('records a failed cell when the body passed but the test already holds an error', async () => {
        const family = createFamily();

        await runObservedFamily(toInput(family, { testErrors: 1 }));

        expect(family.events).toEqual(['body', 'observe:failed', 'close']);
    });

    it('does not let a failing observation replace the body\'s error, and still closes', async () => {
        const family = createFamily();

        await expect(runObservedFamily(toInput(family, { body: bodyFailure, observation: observationFailure })))
            .rejects.toBe(bodyFailure);

        expect(family.events).toEqual(['body', 'observe:failed', 'close']);
    });

    it('fails the run with the observation\'s failure after a passing body, and still closes', async () => {
        const family = createFamily();

        await expect(runObservedFamily(toInput(family, { observation: observationFailure })))
            .rejects.toBe(observationFailure);

        expect(family.events).toEqual(['body', 'observe:passed', 'close']);
    });

    it('does not let a rejecting wait for the roots replace the body\'s error or skip the observation and the close', async () => {
        const family = createFamily();
        const stuckRoot = { commandId: 'stuck', readOutcome: async () => await Promise.reject(new Error('still running')) };
        const input = toInput(family, { body: bodyFailure });

        await expect(runObservedFamily({ ...input, run: { ...family.run, startedRoots: [stuckRoot] } }))
            .rejects.toBe(bodyFailure);

        expect(family.events).toEqual(['body', 'observe:failed', 'close']);
    });

    it('fails the run with the wait\'s failure after a passing body, and still observes and closes', async () => {
        const family = createFamily();
        const stuckRoot = { commandId: 'stuck', readOutcome: async () => await Promise.reject(new Error('still running')) };

        await expect(runObservedFamily({ ...toInput(family, {}), run: { ...family.run, startedRoots: [stuckRoot] } }))
            .rejects.toThrow('still running');

        expect(family.events).toEqual(['body', 'observe:passed', 'close']);
    });

    it('fails the run with the close\'s failure after a passing body and a passing observation', async () => {
        const family = createFamily(closeFailure);

        await expect(runObservedFamily(toInput(family, {}))).rejects.toBe(closeFailure);

        expect(family.events).toEqual(['body', 'observe:passed', 'close']);
    });
});
