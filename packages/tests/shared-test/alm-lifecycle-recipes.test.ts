import { describe, expect, it } from 'vitest';

import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

describe('ALM lifecycle recipe evidence', () => {
    it.each(['ws', 'rtc', 'rtc-with-ws-fallback'] as const)(
        'distinguishes actual replacement, old revision and another carrier over %s',
        async (carrier) => {
            const scenario = createAlmConformanceRecipes({
                group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
                carrier,
                typeId: 'probe',
                senderConnection: 'sender',
                receiverConnection: 'receiver',
                deadlineMs: 18_000
            }).find((candidate) => candidate.scenarioId === 'delivery-lifecycle');
            expect(scenario).toBeDefined();
            const replaceable = scenario!.sender.commands
                .filter((command) => command.kind === 'messages.send')
                .filter((command) =>
                    command.payload !== null && typeof command.payload === 'object' &&
                    !Array.isArray(command.payload) && 'specimen' in command.payload && command.payload.specimen === 'supersedence'
                );
            expect(replaceable).toHaveLength(2);
            expect(replaceable.map((command) => ({ ack: command.ack, seq: command.seq, orderingKey: command.orderingKey })))
                .toEqual([{ ack: 'receiver', seq: undefined, orderingKey: undefined }, { ack: 'receiver', seq: undefined, orderingKey: undefined }]);
            const replacement = scenario!.receiver.commands.find((command) => command.commandId?.endsWith('receive-replacement'));
            const old = scenario!.receiver.commands.find((command) => command.commandId?.endsWith('absent-old'));
            expect(replacement?.kind).toBe('wait');
            expect(old?.kind).toBe('wait');
            expect(old?.timeoutMs).toBe(17_000);
            for (
                const specimen of [
                    { marker: 'delivery-lifecycle', specimen: 'supersedence', carrier, revision: 'old' },
                    { marker: 'delivery-lifecycle', specimen: 'supersedence', carrier: 'another-carrier', revision: 'replacement' }
                ]
            ) {
                const runtime = createRallarBlackBoxTestRuntime({ sleep: async () => {} });
                runtime.recordEvent({ kind: 'message', topic: 'typed', connection: 'receiver', payload: { data: { msgId: 'wrong', payload: specimen } } });
                expect((await runtime.execute({ ...replacement!, timeoutMs: 1 })).ok).toBe(false);
            }
            const runtime = createRallarBlackBoxTestRuntime({ sleep: async () => {} });
            runtime.recordEvent({
                kind: 'message',
                topic: 'typed',
                connection: 'receiver',
                payload: {
                    data: { msgId: 'actual-replacement', payload: { marker: 'delivery-lifecycle', specimen: 'supersedence', carrier, revision: 'replacement' } }
                }
            });
            expect((await runtime.execute(replacement!)).value).toMatchObject({ event: { payload: { data: { msgId: 'actual-replacement' } } } });
            runtime.recordEvent({
                kind: 'message',
                topic: 'typed',
                connection: 'receiver',
                payload: {
                    data: { msgId: 'escaped-old', payload: { marker: 'delivery-lifecycle', specimen: 'supersedence', carrier, revision: 'old' } }
                }
            });
            expect((await runtime.execute(old!)).error?.code).toBe('RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED');
        }
    );

    it('rejects a terminal failure instead of calling it expiry', async () => {
        const scenario = createAlmConformanceRecipes({
            group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
            carrier: 'ws',
            typeId: 'probe',
            senderConnection: 'sender',
            receiverConnection: 'receiver',
            deadlineMs: 18_000
        }).find((candidate) => candidate.scenarioId === 'deadline-expiry')!;
        const observe = scenario.sender.commands.find((command) => command.commandId?.endsWith('observe-expired-1'));
        const assertion = scenario.sender.commands.find((command) => command.commandId?.endsWith('assert-expired-1'));
        expect(observe).toBeDefined();
        expect(assertion).toBeDefined();
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: async (command) =>
                command.kind === 'messages.observe'
                    ? { status: 'ok', value: { state: 'failed' } }
                    : undefined
        });
        await runtime.execute(observe!);
        expect((await runtime.execute(assertion!)).ok).toBe(false);
    });
});
