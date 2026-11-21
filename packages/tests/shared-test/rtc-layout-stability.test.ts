import { describe, expect, it } from 'vitest';

import type { BlackBoxRallarFormationHeldReshape } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { createAlmScaleSetupCommands } from '@shared-test/rallar-bb-test/conformance/alm/scale/create-alm-scale-setup-commands.ts';
import { toStableRtcLayoutWaitTimeoutMs } from '@shared-test/rallar-bb-test/fixtures/create-stable-rtc-layout-wait.ts';
import type { RallarBlackBoxTestLoopResultValue } from '@shared-test/rallar-bb-test/loop/loop-result-contracts.ts';
import type { RallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const roomRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

interface LayoutTransitionFixture {
    readonly runtime: RallarBlackBoxTestRuntime;
    readonly observations: readonly number[];
    now(): number;
}

/** Runs the shipped recipe interpreter; only the browser observation and clock are controlled. */
function createTransitionRuntime(recoveryAtMs: number | undefined): LayoutTransitionFixture {
    let now = 10_000;
    const observations: number[] = [];
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        now: () => now,
        sleep: async (ms) => {
            now += ms;
        },
        commandExecutor: (command) => {
            if (command.kind !== 'formation.readiness') {
                return undefined;
            }
            observations.push(now);
            if (now >= 10_300 && (recoveryAtMs === undefined || now < recoveryAtMs)) {
                return { status: 'failed', error: { code: 'ROOM_NOT_READY', message: 'Accepted layout body absent' } };
            }
            const heldSince = now < 10_300 ? 10_000 : recoveryAtMs!;
            return {
                status: 'ok',
                value: {
                    readyAtEpochMs: now,
                    hasPendingLayout: false,
                    acceptedHeldSinceEpochMs: heldSince,
                    acceptedHeldForMs: now - heldSince,
                    heldReshape: { reading: 'none', readAtEpochMs: now },
                    formation: { causalRevision: { groupRevision: now < 10_300 ? 36 : 38, presenceRevision: 26 } }
                }
            };
        }
    });
    return { runtime, observations, now: () => now };
}

/** A settled page whose formation view reads as `toReading` says; its layout is replaced at `replacedAtMs`. */
function createHeldReshapeRuntime(
    replacedAtMs: number | undefined,
    toReading: (now: number) => BlackBoxRallarFormationHeldReshape
): LayoutTransitionFixture {
    let now = 10_000;
    const observations: number[] = [];
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        now: () => now,
        sleep: async (ms) => {
            now += ms;
        },
        commandExecutor: (command) => {
            if (command.kind !== 'formation.readiness') {
                return undefined;
            }
            observations.push(now);
            const heldSince = replacedAtMs !== undefined && now >= replacedAtMs ? replacedAtMs : 0;
            return {
                status: 'ok',
                value: {
                    readyAtEpochMs: now,
                    hasPendingLayout: false,
                    acceptedHeldSinceEpochMs: heldSince,
                    acceptedHeldForMs: now - heldSince,
                    heldReshape: toReading(now),
                    formation: { causalRevision: { groupRevision: 36, presenceRevision: 26 } }
                }
            };
        }
    });
    return { runtime, observations, now: () => now };
}

function stableLayoutCommand() {
    const command = createAlmScaleSetupCommands({
        group: roomRef,
        participantCount: 6,
        readyTimeoutMs: 10_000,
        almDiagnostics: false
    }, 'director').find((candidate) => candidate.commandId === 'alm-scale-director-layout-stable');
    if (command === undefined) {
        throw new Error('Scale setup must wait for a stable accepted layout');
    }
    return command;
}

describe('RTC layout stability before a measured send', () => {
    it('does not admit traffic when authority removes the ready layout without a planned-layout event', async () => {
        const fixture = createTransitionRuntime(undefined);
        const result = await fixture.runtime.execute(stableLayoutCommand());

        expect(result.status).toBe('failed');
        expect(fixture.observations.length).toBeGreaterThan(1);
    });

    it('observes recovery and a complete quiet window on the replacement before admitting traffic', async () => {
        const fixture = createTransitionRuntime(12_000);
        const result = await fixture.runtime.execute(stableLayoutCommand());

        expect(result.status).toBe('ok');
        expect(fixture.now()).toBeGreaterThanOrEqual(15_500);
        expect(fixture.observations).toContain(12_000);
    });
});

describe('a held reshape before a measured send', () => {
    it('waits a hold of the default upper bound out and then a quiet window on the reshaped layout', async () => {
        const releasedAtMs = 10_000 + 60_000;
        const fixture = createHeldReshapeRuntime(releasedAtMs, (now) =>
            now < releasedAtMs
                ? { reading: 'held', readAtEpochMs: 10_000, wantedReasons: ['kind-change'], opensAtEpochMs: releasedAtMs }
                : { reading: 'none', readAtEpochMs: now });
        const result = await fixture.runtime.execute(stableLayoutCommand());

        expect(result.status).toBe('ok');
        expect(fixture.now()).toBeGreaterThanOrEqual(releasedAtMs + 3_500);
        expect(fixture.now()).toBeLessThan(releasedAtMs + 5_000);
    });

    it('waits out the layout-stale gap between a release and the page holding the reshaped layout', async () => {
        const releasedAtMs = 10_000 + 20_000;
        const replacedAtMs = releasedAtMs + 400;
        const fixture = createHeldReshapeRuntime(replacedAtMs, (now) => {
            if (now < releasedAtMs) {
                return { reading: 'held', readAtEpochMs: 10_000, wantedReasons: ['kind-change'], opensAtEpochMs: releasedAtMs };
            }
            return now < replacedAtMs ? { reading: 'layout-stale', readAtEpochMs: now } : { reading: 'none', readAtEpochMs: now };
        });
        const result = await fixture.runtime.execute(stableLayoutCommand());

        expect(result.status).toBe('ok');
        expect(fixture.now()).toBeGreaterThanOrEqual(replacedAtMs + 3_500);
    });

    it('fails at its limit when the reshape stays held', async () => {
        const fixture = createHeldReshapeRuntime(undefined, () => ({
            reading: 'held',
            readAtEpochMs: 10_000,
            wantedReasons: ['leader-rooting'],
            opensAtEpochMs: 5_000
        }));
        const result = await fixture.runtime.execute(stableLayoutCommand());

        expect(result.status).toBe('failed');
        // It kept observing to its limit: the 10 s settle allowance and one hold of the upper bound.
        expect(fixture.observations.at(-1)! - 10_000).toBeGreaterThanOrEqual(69_000);
        expect(fixture.observations.at(-1)! - 10_000).toBeLessThanOrEqual(70_000);
    });

    it('never passes on an observation that did not read the view', async () => {
        const fixture = createHeldReshapeRuntime(undefined, () => ({
            reading: 'not-read',
            because: 'view-read-failed',
            message: 'Formation view read timed out'
        }));
        const result = await fixture.runtime.execute(stableLayoutCommand());

        expect(result.status).toBe('failed');
        expect(fixture.observations.at(-1)! - 10_000).toBeGreaterThanOrEqual(69_000);
        expect(fixture.observations.at(-1)! - 10_000).toBeLessThanOrEqual(70_000);
        const { results } = result.value as RallarBlackBoxTestLoopResultValue;
        expect([...new Set(results.filter((child) => !child.result.ok).map((child) => child.originalCommandId))])
            .toEqual(['alm-scale-director-assert-no-held-reshape']);
    });

    it('allows for one hold at the default policy\'s upper bound', () => {
        expect(toStableRtcLayoutWaitTimeoutMs(45_000))
            .toBe(45_000 + createDefaultGroupLifecyclePolicy().topology.reshapeMaxIntervalMs);
    });
});

it.each(['rtc', 'rtc-with-ws-fallback'] as const)('settles %s before starting the paced-fairness lead admission clock', (carrier) => {
    const scenario = createAlmConformanceRecipes(toConformanceInput(carrier))
        .find((candidate) => candidate.scenarioId === 'paced-fairness')!;
    const commands = scenario.sender.commands;
    const lead = commands.findIndex((command) => command.kind === 'messages.send');

    expect(commands[lead - 1]).toMatchObject({ kind: 'loop', until: 'first-success' });
    expect(commands[lead + 1]).toMatchObject({ kind: 'messages.observe', timeoutMs: 1_000 });
});
