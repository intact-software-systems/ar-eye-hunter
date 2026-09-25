import { isRallarBlackBoxTestMessagesSendCommand } from '@shared-test/rallar-bb-test/alm/is-rallar-black-box-test-messages-send-command.ts';
import { describe, expect, it } from 'vitest';

import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

type LifecycleCarrier = 'ws' | 'rtc' | 'rtc-with-ws-fallback';

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
                .filter(isRallarBlackBoxTestMessagesSendCommand)
                .filter((command) =>
                    command.payload !== null && typeof command.payload === 'object' &&
                    !Array.isArray(command.payload) && 'specimen' in command.payload && command.payload.specimen === 'supersedence'
                );
            expect(replaceable).toHaveLength(2);
            expect(replaceable.map((command) => ({ ack: command.ack, seq: command.seq, orderingKey: command.orderingKey })))
                .toEqual([{ ack: 'receiver', seq: undefined, orderingKey: undefined }, { ack: 'receiver', seq: undefined, orderingKey: undefined }]);
            expectReplacementSubmittedAfterRelease(scenario!.sender.commands);
            expectNoSingleAcknowledgedObserve(scenario!.sender.commands);
            expectReceiptsAfterSupersedeRelease(scenario!.sender.commands);
            const replacement = scenario!.receiver.commands.find((command) => command.commandId?.endsWith('receive-replacement'));
            const old = scenario!.receiver.commands.find((command) => command.commandId?.endsWith('absent-old'));
            expect(replacement?.kind).toBe('wait');
            expect(old?.kind).toBe('wait');
            expect(old?.timeoutMs).toBe(17_000);
            await expectPayloadWaitRejects(replacement!, [
                { marker: 'delivery-lifecycle', specimen: 'supersedence', carrier, revision: 'old' },
                { marker: 'delivery-lifecycle', specimen: 'supersedence', carrier: 'another-carrier', revision: 'replacement' }
            ]);
            await expectReplacementPair(replacement!, old!, carrier);
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

function expectReplacementSubmittedAfterRelease(
    commands: readonly RallarBlackBoxTestCommand[]
): void {
    const releaseIndex = commands.findLastIndex((command) => command.commandId?.includes('supersede-release-'));
    const submittedIndex = commands.findIndex((command) => command.commandId?.endsWith('observe-transport-accepted-4'));
    expect(commands[submittedIndex]?.kind).toBe('messages.observe');
    expect(submittedIndex).toBeGreaterThan(releaseIndex);
}

/** D28: the sender no longer polls a single-state `acknowledged` wait after the send. */
function expectNoSingleAcknowledgedObserve(commands: readonly RallarBlackBoxTestCommand[]): void {
    const observes = commands.filter((command) => command.kind === 'messages.observe');
    expect(observes.some((command) => command.state.length === 1 && command.state[0] === 'acknowledged')).toBe(false);
}

function expectReceiptsAfterSupersedeRelease(commands: readonly RallarBlackBoxTestCommand[]): void {
    const releaseIndex = commands.findLastIndex((command) => command.commandId?.includes('supersede-release-'));
    const receiptsIndex = commands.findIndex((command) => command.commandId?.endsWith('receipts-1'));
    expect(commands[receiptsIndex]?.kind).toBe('messages.receipts');
    expect(receiptsIndex).toBeGreaterThan(releaseIndex);
}

async function expectPayloadWaitRejects(
    command: RallarBlackBoxTestCommand,
    specimens: readonly Record<string, string>[]
): Promise<void> {
    for (const specimen of specimens) {
        const runtime = createRallarBlackBoxTestRuntime({ sleep: async () => {} });
        runtime.recordEvent({
            kind: 'message',
            topic: 'typed',
            connection: 'receiver',
            payload: { data: { msgId: 'wrong', payload: specimen } }
        });
        expect((await runtime.execute({ ...command, timeoutMs: 1 })).ok).toBe(false);
    }
}

async function expectReplacementPair(
    replacement: RallarBlackBoxTestCommand,
    old: RallarBlackBoxTestCommand,
    carrier: LifecycleCarrier
): Promise<void> {
    const runtime = createRallarBlackBoxTestRuntime({ sleep: async () => {} });
    runtime.recordEvent(toLifecycleEvent('actual-replacement', { marker: 'delivery-lifecycle', specimen: 'supersedence', carrier, revision: 'replacement' }));
    expect((await runtime.execute(replacement)).value).toMatchObject({ event: { payload: { data: { msgId: 'actual-replacement' } } } });
    runtime.recordEvent(toLifecycleEvent('escaped-old', { marker: 'delivery-lifecycle', specimen: 'supersedence', carrier, revision: 'old' }));
    expect((await runtime.execute(old)).error?.code).toBe('RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED');
}

function toLifecycleEvent(msgId: string, payload: Record<string, string>) {
    return {
        kind: 'message' as const,
        topic: 'typed',
        connection: 'receiver',
        payload: { data: { msgId, payload } }
    };
}
