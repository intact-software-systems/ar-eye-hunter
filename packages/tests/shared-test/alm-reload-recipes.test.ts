import {
    describe,
    expect,
    it
} from 'vitest';

import { bindAlmReloadPair, toAlmReloadCheckpoints } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

describe('ALM durable reload specimens', () => {
    it.each(['ws', 'rtc', 'rtc-with-ws-fallback'] as const)('holds one %s original across an executable full-only reload checkpoint', async (carrier) => {
        const scenario = createAlmConformanceRecipes({
            group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
            carrier,
            typeId: 'probe',
            senderConnection: 'sender',
            receiverConnection: 'receiver',
            deadlineMs: 18_000
        }).find((candidate) => candidate.scenarioId === 'delivery-reload');
        expect(scenario, 'full conformance must exercise real document replacement').toBeDefined();
        expect(scenario!.tags).toEqual(['full']);
        const sender = scenario!.sender;
        const receiver = scenario!.receiver;
        const checkpoints = toAlmReloadCheckpoints(sender.metadata?.almReloadCheckpoints);
        expect(checkpoints).toHaveLength(1);
        expect(receiver.metadata?.almReloadCheckpoints).toEqual(checkpoints);
        const bound = bindAlmReloadPair({
            sender: {
                kind: 'command',
                protocolVersion: 1,
                runId: 'run',
                agentId: 'sender',
                commandId: 'sender-root',
                command: { kind: 'recipe.run', recipe: sender, timeoutMs: 180_000 }
            },
            receiver: {
                kind: 'command',
                protocolVersion: 1,
                runId: 'run',
                agentId: 'receiver',
                commandId: 'receiver-root',
                command: { kind: 'recipe.run', recipe: receiver, timeoutMs: 180_000 }
            }
        });
        expect(bound.left).toBeUndefined();
        const checkpoint = checkpoints![0];
        const prefixEnd = sender.commands.findIndex((command) => command.commandId === checkpoint.senderPrefixEnd);
        const reloadIndex = sender.commands.findIndex((command) => command.commandId === checkpoint.senderReload);
        expect(reloadIndex).toBe(prefixEnd + 1);
        expect(sender.commands[reloadIndex].kind).toBe('agent.reload');
        const prefix = sender.commands.slice(0, prefixEnd + 1);
        const sends = sender.commands.filter((command) => command.kind === 'messages.send');
        expect(sends).toHaveLength(1);
        expect(sends[0]).toMatchObject({
            carrier,
            typeId: `probe.${carrier}.delivery-reload`,
            payload: { marker: 'delivery-reload', carrier },
            ack: 'receiver'
        });
        expect(sends[0].ttlMs).toBeUndefined();
        expect(prefix).toContain(sends[0]);
        const baselineIndex = prefix.findIndex((command) => command.commandId?.endsWith('storage-counters-connected'));
        const heldIndex = prefix.findIndex((command) => command.commandId?.endsWith('storage-counters-held'));
        expect(baselineIndex).toBeGreaterThanOrEqual(0);
        expect(baselineIndex).toBeLessThan(prefix.indexOf(sends[0]));
        expect(heldIndex).toBeGreaterThan(prefix.indexOf(sends[0]));
        const holds = prefix.filter((command) => command.kind === 'fault.inject');
        expect(holds.map((command) => ({ carrier: command.carrier, action: command.action, remaining: command.remaining, match: command.match })))
            .toEqual((carrier === 'rtc-with-ws-fallback' ? ['rtc', 'ws'] : [carrier]).map((heldCarrier) => ({
                carrier: heldCarrier,
                action: heldCarrier === 'ws' ? 'not-ready' : 'drop',
                remaining: 'until-cleared',
                match: { typeId: `probe.${carrier}.delivery-reload` }
            })));
        expect(prefix.filter((command) => ['rtc.close', 'reset', 'messages.cancel'].includes(command.kind))).toEqual([]);
        const reconnect = sender.commands[reloadIndex + 1];
        expect(reconnect).toMatchObject({ kind: 'rtc.connect', rallar: { username: '', password: '', restoreSession: true } });
        expect(sender.commands.filter((command) => command.kind === 'storage.counters').every((command) => command.reset === false)).toBe(true);
        expect(receiver.commands.filter((command) => command.kind === 'rtc.connect')).toHaveLength(1);
        expect(receiver.commands.find((command) => command.commandId === checkpoint.receiverReadyEnd)?.kind).toBe('health');
        expect(receiver.commands.find((command) => command.commandId === checkpoint.receiverRecoveryEnd)?.kind).toBe('health');

        const absence = receiver.commands.find((command) => command.commandId === checkpoint.receiverAbsenceEnd)!;
        expect(absence).toMatchObject({ kind: 'wait', absent: true, timeoutMs: 17_000 });
        const receive = receiver.commands.find((command) => command.kind === 'wait' && command.absent !== true)!;
        const unrelatedRuntime = createRallarBlackBoxTestRuntime({ sleep: async () => {} });
        unrelatedRuntime.recordEvent({
            kind: 'message',
            connection: 'receiver',
            topic: 'typed',
            payload: { data: { msgId: 'another-carrier', payload: { marker: 'delivery-reload', carrier: 'unrelated-carrier' } } }
        });
        expect((await unrelatedRuntime.execute({ ...receive, timeoutMs: 1 })).ok).toBe(false);
        const runtime = createRallarBlackBoxTestRuntime({ sleep: async () => {} });
        runtime.recordEvent({
            kind: 'message',
            connection: 'receiver',
            topic: 'typed',
            payload: { data: { msgId: 'escaped-original', payload: { marker: 'delivery-reload', carrier } } }
        });
        expect((await runtime.execute(absence)).error?.code).toBe('RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED');
        expect((await runtime.execute(receive)).value).toMatchObject({ event: { payload: { data: { msgId: 'escaped-original' } } } });

        const evidence = prefix.filter((command) => command.kind === 'messages.observe' || command.kind === 'assert' || command.kind === 'storage.counters');
        for (
            const observation of [
                { state: 'accepted', enqueued: true, submitted: false },
                { state: 'accepted', enqueued: false, submitted: false },
                { state: 'accepted', enqueued: true, submitted: true },
                { state: 'expired', enqueued: true, submitted: false }
            ]
        ) {
            const invalidRuntime = createRallarBlackBoxTestRuntime({
                commandExecutor: (command) =>
                    command.kind === 'messages.observe'
                        ? { status: 'ok', value: observation }
                        : command.kind === 'storage.counters'
                        ? { status: 'ok', value: { total: 2, byOwner: { 'al-admission': 1, 'al-work': 1 }, byKind: { write: 1, 'work-read': 1 } } }
                        : undefined
            });
            const outcome = await invalidRuntime.execute({ kind: 'recipe.run', recipe: { ...sender, commands: evidence } });
            expect(outcome.ok, JSON.stringify(observation)).toBe(observation.state === 'accepted' && observation.enqueued && !observation.submitted);
        }
        for (const byKind of [{ read: 2 }, { write: 0, 'work-write': 1 }]) {
            const storageRuntime = createRallarBlackBoxTestRuntime({
                commandExecutor: (command) =>
                    command.kind === 'messages.observe'
                        ? { status: 'ok', value: { state: 'accepted', enqueued: true, submitted: false } }
                        : command.kind === 'storage.counters'
                        ? { status: 'ok', value: { total: 2, byOwner: { 'al-admission': 1, 'al-work': 1 }, byKind } }
                        : undefined
            });
            expect((await storageRuntime.execute({ kind: 'recipe.run', recipe: { ...sender, commands: evidence } })).ok, JSON.stringify(byKind)).toBe(false);
        }
        const oldHandle = sender.commands.find((command) => command.kind === 'messages.observe' && command.state.includes('unobservable'));
        expect(oldHandle).toMatchObject({ handleId: sends[0].handleId });
        const suffixEvidence = sender.commands.slice(reloadIndex + 1).filter((command) => command.kind === 'messages.observe' || command.kind === 'assert');
        for (const state of ['queued', 'unobservable']) {
            const restoredRuntime = createRallarBlackBoxTestRuntime({
                commandExecutor: (command) => command.kind === 'messages.observe' ? { status: 'ok', value: { state } } : undefined
            });
            expect((await restoredRuntime.execute({ kind: 'recipe.run', recipe: { ...sender, commands: suffixEvidence } })).ok).toBe(state === 'unobservable');
        }
    });
});
