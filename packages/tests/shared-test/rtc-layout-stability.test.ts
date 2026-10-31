import { describe, expect, it } from 'vitest';

import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { createAlmScaleSetupCommands } from '@shared-test/rallar-bb-test/conformance/alm/scale/create-alm-scale-setup-commands.ts';
import type { RallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

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
                    formation: { causalRevision: { groupRevision: now < 10_300 ? 36 : 38, presenceRevision: 26 } }
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

it.each(['rtc', 'rtc-with-ws-fallback'] as const)('settles %s before starting the paced-fairness lead admission clock', (carrier) => {
    const scenario = createAlmConformanceRecipes({
        group: roomRef,
        carrier,
        senderConnection: 'sender',
        receiverConnection: 'receiver',
        typeId: 'test',
        deadlineMs: 18_000
    }).find((candidate) => candidate.scenarioId === 'paced-fairness')!;
    const commands = scenario.sender.commands;
    const lead = commands.findIndex((command) => command.kind === 'messages.send');

    expect(commands[lead - 1]).toMatchObject({ kind: 'loop', until: 'first-success' });
    expect(commands[lead + 1]).toMatchObject({ kind: 'messages.observe', timeoutMs: 1_000 });
});
