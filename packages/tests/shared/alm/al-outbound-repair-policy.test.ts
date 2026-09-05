import { describe, expect, it } from 'vitest';

import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundRepairTrackingPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import { createDefaultOutboundTestRuntime, createOutboundMessage, enqueueOutboundOrThrow } from './outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from './outbound-test-payload.ts';

interface RepairPolicyCase {
    readonly name: string;
    readonly repair: ALOutboundRepairTrackingPlan;
    readonly noCurrentRecipient: boolean;
}

const repairCases: readonly RepairPolicyCase[] = [
    { name: 'disabled repair policy', repair: { enabled: false, algo: 'none', maxAttempts: 0 }, noCurrentRecipient: false },
    { name: 'exhausted repair budget', repair: { enabled: true, algo: 'retransmit', maxAttempts: 0 }, noCurrentRecipient: false },
    { name: 'no current authorized recipient', repair: { enabled: true, algo: 'retransmit', maxAttempts: 3 }, noCurrentRecipient: true }
];

describe('AL outbound repair policy', () => {
    it.each(repairCases)('does not broaden repair into a retransmit after $name', async (scenario) => {
        const sent: OutboundTestPayload[] = [];
        const message = createOutboundMessage('repair-policy');
        const runtime = createDefaultOutboundTestRuntime({
            planOutgoingMessage: (msg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                repairTracking: scenario.repair
            }),
            planRepairMessage: async (msg) =>
                scenario.noCurrentRecipient
                    ? undefined
                    : { persist: false, preparedMessages: [{ kind: 'repair', msgId: msg.id.msgId }] },
            sendPreparedMessage: async (prepared) => {
                sent.push(prepared);
            }
        });
        await enqueueOutboundOrThrow(runtime, message);

        await runtime.acceptControlMessage(newALNackControlMessage(
            { v: 2, msgId: 'gap-control', senderId: 'peer-1', ts: 1 },
            { msgId: message.id.msgId, fromPeerId: 'peer-1', toPeerId: 'self', reason: 'gap', observedAtEpochMs: 1 }
        ));

        expect(sent).toEqual([{ kind: 'send', msgId: message.id.msgId }]);
    });
});
