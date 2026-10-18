import { afterEach, describe, expect, it, vi } from 'vitest';

import { TryWithExhaustedError } from '@shared/resilience/try-with-policy.ts';

import type { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import { jsonRecord } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';
import { createLiveRtcFormationOperations } from '../../../tests/playwright/rallar-black-box/live-rtc-formation-operations.ts';

const roomRef = { applicationId: 'application', workspaceId: 'workspace', groupId: 'room' };

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('exact formation peer readiness', () => {
    it('returns an already exact layout from one canonical observation', async () => {
        const fixture = createReadinessFixture([{ desired: ['B', 'C'], ready: ['B', 'C'], durationMs: 10 }]);
        const outcome = fixture.operations.readiness(fixture.input);
        await vi.runAllTimersAsync();

        expect((await outcome).formation.room.readyPeerIds).toEqual(['B', 'C']);
        expect(fixture.commands).toHaveLength(1);
        expect(fixture.refreshes).toEqual([1_000]);
    });
    it('keeps observing a valid survivor layout until both desired and ready sets are exact', async () => {
        const fixture = createReadinessFixture([
            { desired: ['B'], ready: ['B'], durationMs: 10 },
            { desired: ['B', 'C'], ready: ['B'], durationMs: 10 },
            { desired: ['C', 'B'], ready: ['B', 'C'], durationMs: 10 }
        ]);
        const pending = fixture.operations.readiness(fixture.input);
        const outcome = pending.then((value) => ({ value }));
        await vi.runAllTimersAsync();
        const { value } = await outcome;

        expect(value.formation.room.desiredPeerIds).toEqual(['C', 'B']);
        expect(value.formation.room.readyPeerIds).toEqual(['B', 'C']);
        expect(fixture.refreshes).toEqual([1_000]);
        expect(new Set(fixture.commands.map((command) => command.commandId)).size).toBe(3);
        expect(fixture.commands.every((command) => command.command.kind === 'formation.readiness')).toBe(true);
    });

    it.each([
        { description: 'permanent subset', desired: ['B'], ready: ['B'] },
        { description: 'extra desired peer', desired: ['B', 'C', 'D'], ready: ['B', 'C'] },
        { description: 'extra ready peer', desired: ['B', 'C'], ready: ['B', 'C', 'D'] }
    ])('expires a $description with the exact last mismatch and no new budget', async ({ desired, ready }) => {
        const fixture = createReadinessFixture([{ desired, ready, durationMs: 20 }]);
        const outcome = fixture.operations.readiness(fixture.input).catch((error: Error) => error);
        await vi.runAllTimersAsync();
        const failure = await outcome;

        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toContain('exact');
        expect(String(failure)).toContain(JSON.stringify(desired));
        expect(String(failure)).toContain(JSON.stringify(ready));
        expect(performance.now()).toBe(1_000);
        expect(fixture.commands.length).toBeGreaterThan(1);
        expect(fixture.commands.length).toBeLessThan(12);
    });

    it('charges refresh, observation, and poll waits to one monotonic deadline', async () => {
        const fixture = createReadinessFixture([
            { desired: ['B'], ready: ['B'], durationMs: 100 },
            { desired: ['B', 'C'], ready: ['B', 'C'], durationMs: 100 }
        ], 200);
        vi.spyOn(Date, 'now').mockReturnValue(9_000_000_000_000);
        const outcome = fixture.operations.readiness(fixture.input);
        await vi.runAllTimersAsync();
        await outcome;

        expect(fixture.commands.map(({ command, timeoutMs }) => ({
            browser: 'timeoutMs' in command ? command.timeoutMs : undefined,
            control: timeoutMs
        }))).toEqual([
            { browser: 800, control: 30_800 },
            { browser: 600, control: 30_600 }
        ]);
        expect(performance.now()).toBe(500);
    });

    it('does not dispatch after refresh consumes the entire budget', async () => {
        const fixture = createReadinessFixture([], 1_000);
        const outcome = fixture.operations.readiness(fixture.input).catch((error: Error) => error);
        await vi.runAllTimersAsync();

        expect(String(await outcome)).toContain('deadline');
        expect(fixture.commands).toEqual([]);
    });

    it('preserves a terminal refresh failure without dispatching', async () => {
        const fixture = createReadinessFixture([]);
        const failure = new Error('exact room refresh unavailable');
        fixture.input.agent.refreshRoom = async () => {
            throw failure;
        };

        await expect(fixture.operations.readiness(fixture.input)).rejects.toBe(failure);
        expect(fixture.commands).toEqual([]);
    });

    it('preserves a terminal canonical wait failure after a transient mismatch', async () => {
        const failure = new Error('rtc-connect-attempt-budget-exhausted');
        const fixture = createReadinessFixture([
            { desired: ['B'], ready: ['B'], durationMs: 10 },
            failure
        ]);
        const outcome = fixture.operations.readiness(fixture.input).catch((error: Error) => error);
        await vi.runAllTimersAsync();

        expect(await outcome).toBe(failure);
        expect(fixture.commands).toHaveLength(2);
    });

    it('preserves canonical retry exhaustion as the terminal error rather than unwrapping its cause', async () => {
        const failure = new TryWithExhaustedError('control transport exhausted', {
            attempt: 1,
            maxAttempts: 1,
            elapsedMsecs: 1,
            error: new Error('transport unavailable')
        }, { cause: new Error('transport unavailable') });
        const fixture = createReadinessFixture([failure]);
        const outcome = fixture.operations.readiness(fixture.input).catch((error: Error) => error);
        await vi.runAllTimersAsync();

        expect(await outcome).toBe(failure);
    });

    it('preserves a terminal wait failure even when its control result arrives after the readiness deadline', async () => {
        const fixture = createReadinessFixture([]);
        const failure = new Error('canonical room wait timed out');
        fixture.input.control.executeOk = async () => {
            await new Promise((resolve) => setTimeout(resolve, 1_001));
            throw failure;
        };
        const outcome = fixture.operations.readiness(fixture.input).catch((error: Error) => error);
        await vi.runAllTimersAsync();

        expect(await outcome).toBe(failure);
    });
});

interface ReadinessObservation {
    readonly desired: readonly string[];
    readonly ready: readonly string[];
    readonly durationMs: number;
}

function createReadinessFixture(observations: readonly (ReadinessObservation | Error)[], refreshMs = 0) {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const commands: LiveRtcControlClient.ExecuteInput[] = [];
    const refreshes: number[] = [];
    const input = {
        control: {
            executeOk: async (command: LiveRtcControlClient.ExecuteInput): Promise<LiveRtcControlClient.Result> => {
                commands.push(command);
                const observation = observations[Math.min(commands.length - 1, observations.length - 1)];
                if (observation instanceof Error) {
                    throw observation;
                }
                if (!observation) {
                    throw new Error('Unexpected readiness command');
                }
                await new Promise((resolve) => setTimeout(resolve, observation.durationMs));
                return toReadinessResult(command, observation);
            },
            resultValue: (result: LiveRtcControlClient.Result) => jsonRecord(result.result?.value) ?? {}
        },
        runId: 'run',
        agent: {
            prefix: 'A' as const,
            agentId: 'agent-A',
            actor: 'alice',
            connection: 'connection-A',
            refreshRoom: async (refresh: { timeoutMs?: number; }) => {
                refreshes.push(refresh.timeoutMs ?? -1);
                await new Promise((resolve) => setTimeout(resolve, refreshMs));
            }
        },
        roomRef,
        suffix: 'same-suffix',
        timeoutMs: 1_000,
        expectedPeerIds: ['B', 'C']
    };
    return { operations: createLiveRtcFormationOperations(), input, commands, refreshes };
}

function toReadinessResult(command: LiveRtcControlClient.ExecuteInput, observation: ReadinessObservation): LiveRtcControlClient.Result {
    return {
        commandId: command.commandId,
        agentId: command.agentId,
        ok: true,
        result: {
            value: {
                readyAtEpochMs: 123,
                formation: {
                    roomRef,
                    stage: 'active',
                    formationEpoch: 6,
                    formationAttemptCount: 1,
                    causalRevision: { groupRevision: 20, presenceRevision: 10 },
                    transportState: 'flowing',
                    dialing: 'accepted',
                    memberPolicy: { maxConcurrentEdgeSetups: 4, transports: 'rtc-and-ws' },
                    room: {
                        state: 'open',
                        acceptedLayoutIdentity: { groupRevision: 18, presenceRevision: 10, version: 9, state: 'active' },
                        desiredPeerIds: [...observation.desired],
                        readyPeerIds: [...observation.ready],
                        activePeerIds: [...observation.ready],
                        failedPeerIds: []
                    }
                }
            }
        }
    };
}
