import {
    describe,
    expect,
    it
} from 'vitest';

import { isRallarBlackBoxTestMessagesSendCommand } from '@shared-test/rallar-bb-test/alm/is-rallar-black-box-test-messages-send-command.ts';
import { bindAlmReloadPair, toAlmReloadCheckpoints } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';

import { createAlmConformance2AgentEntry } from '../../../apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts';

describe('hosted ALM reload composition', () => {
    it('keeps three contiguous reload checkpoints before ordinary work and preserves the receiver subscription', () => {
        const manifest = createAlmConformance2AgentEntry().manifest;
        const sender = manifest.recipes.find((selection) => selection.role === 'sender')!.recipe!;
        const receiver = manifest.recipes.find((selection) => selection.role === 'receiver')!.recipe!;
        const checkpoints = toAlmReloadCheckpoints(sender.metadata?.almReloadCheckpoints);
        expect(checkpoints, 'combined recipe must retain executable authored checkpoint boundaries').toHaveLength(3);
        expect(receiver.metadata?.almReloadCheckpoints).toEqual(checkpoints);
        expect(manifest.metadata?.recommendedTerminalTimeoutSeconds).toBe(300);
        expect(
            bindAlmReloadPair({
                sender: {
                    kind: 'command',
                    protocolVersion: 1,
                    runId: manifest.controlRunId,
                    agentId: 'controller-01',
                    commandId: 'sender-root',
                    command: { kind: 'recipe.run', recipe: sender, timeoutMs: 300_000 }
                },
                receiver: {
                    kind: 'command',
                    protocolVersion: 1,
                    runId: manifest.controlRunId,
                    agentId: 'controller-02',
                    commandId: 'receiver-root',
                    command: { kind: 'recipe.run', recipe: receiver, timeoutMs: 300_000 }
                }
            }).left
        ).toBeUndefined();
        const initialConnect = sender.commands.find((command) => command.kind === 'rtc.connect')!;
        expect(initialConnect).toMatchObject({
            transport: 'messages.rtc',
            readiness: { minReadyPeers: 1 },
            rallar: { messageSelector: { topicId: 'room.alm-conformance' } }
        });
        const receiverConnects = receiver.commands.filter((command) => command.kind === 'rtc.connect');
        expect(receiverConnects).toHaveLength(1);
        expect(receiverConnects[0]).toMatchObject({
            transport: 'messages.rtc',
            rallar: { messageSelector: { topicId: 'room.alm-conformance' } }
        });

        let senderStart = 0;
        let receiverStart = 0;
        for (const [index, checkpoint] of checkpoints!.entries()) {
            const prefixEnd = sender.commands.findIndex((command) => command.commandId === checkpoint.senderPrefixEnd);
            const reloadIndex = sender.commands.findIndex((command) => command.commandId === checkpoint.senderReload);
            const suffixEnd = sender.commands.findIndex((command) => command.commandId === checkpoint.senderSuffixEnd);
            const carrier = ['ws', 'rtc', 'rtc-with-ws-fallback'][index];
            const prefix = sender.commands.slice(senderStart, prefixEnd + 1);
            expect(prefix.filter(isRallarBlackBoxTestMessagesSendCommand).map((command) => command.payload))
                .toEqual([{ marker: 'delivery-reload', carrier }]);
            const sendIndex = prefix.findIndex((command) => command.kind === 'messages.send');
            const baselineIndex = prefix.findIndex((command) => command.commandId?.endsWith('storage-counters-connected'));
            const heldIndex = prefix.findIndex((command) => command.commandId?.endsWith('storage-counters-held'));
            expect(baselineIndex).toBeGreaterThanOrEqual(0);
            expect(baselineIndex).toBeLessThan(sendIndex);
            expect(heldIndex).toBeGreaterThan(sendIndex);
            expect(reloadIndex).toBe(prefixEnd + 1);
            expect(sender.commands[reloadIndex]).toMatchObject({ kind: 'agent.reload', readyTimeoutMs: 30_000 });
            const suffix = sender.commands.slice(reloadIndex + 1, suffixEnd + 1);
            expect(suffix[0]).toMatchObject({
                kind: 'rtc.connect',
                transport: 'messages.rtc',
                connection: initialConnect.connection,
                roomRef: initialConnect.roomRef,
                readiness: { minReadyPeers: 1, timeoutMs: 30_000 },
                rallar: { messageSelector: { topicId: 'room.alm-conformance' }, username: '', password: '', restoreSession: true }
            });
            expect(suffix.filter((command) => command.kind === 'messages.send')).toEqual([]);
            const readyEnd = receiver.commands.findIndex((command) => command.commandId === checkpoint.receiverReadyEnd);
            const absenceEnd = receiver.commands.findIndex((command) => command.commandId === checkpoint.receiverAbsenceEnd);
            const recoveryEnd = receiver.commands.findIndex((command) => command.commandId === checkpoint.receiverRecoveryEnd);
            expect(receiver.commands.slice(receiverStart, readyEnd + 1).filter((command) => command.kind === 'wait')).toEqual([]);
            expect(receiver.commands.slice(readyEnd + 1, absenceEnd + 1)).toEqual([
                expect.objectContaining({ kind: 'wait', absent: true, match: expect.objectContaining({ equals: { marker: 'delivery-reload', carrier } }) })
            ]);
            expect(receiver.commands.slice(absenceEnd + 1, recoveryEnd + 1).map((command) => command.kind)).toEqual(['wait', 'health']);
            senderStart = suffixEnd + 1;
            receiverStart = recoveryEnd + 1;
        }
        expect(sender.commands.slice(senderStart).some((command) => command.kind === 'messages.send')).toBe(true);
        expect(sender.commands.slice(senderStart).some((command) => command.kind === 'rtc.connect')).toBe(false);
        expect(receiver.commands.slice(receiverStart).some((command) => command.kind === 'messages.received')).toBe(true);
    });
});
