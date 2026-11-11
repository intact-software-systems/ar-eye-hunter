import { describe, expect, it } from 'vitest';

import type { AlmConformanceCarrier } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type { RecordedAlmConformanceParticipant } from '@shared-test/rallar-bb-test/conformance/alm/identity/assess-alm-conformance-identity.ts';
import { assessAlmReceiptRoleIdentity } from '@shared-test/rallar-bb-test/conformance/alm/identity/assess-alm-receipt-role-identity.ts';
import type { RallarBlackBoxTestRecipe, RallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

interface ReceiptLists {
    readonly confirmedRecipientPeerIds: readonly string[];
    readonly unconfirmedRecipientPeerIds: readonly string[];
    readonly expectedRecipientPeerIds: readonly string[];
    readonly outsideAudienceRecipientPeerIds: readonly string[];
}

function toRetryScenario(carrier: AlmConformanceCarrier) {
    const scenario = createAlmConformanceRecipes({
        group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
        carrier,
        typeId: 'receipt-roles',
        senderConnection: 'sender',
        receiverConnection: 'receiver',
        deadlineMs: 18_000,
        laneFamilies: ['three-agent'],
        principalIdsByRole: {}
    }).find((candidate) => candidate.scenarioKey === 'missing-recipient-retry');
    if (scenario?.recipientB === undefined) {
        throw new Error('The generated retry scenario must declare recipient-b.');
    }
    return { ...scenario, recipientB: scenario.recipientB };
}

function toForgedAckScenario() {
    const scenario = createAlmConformanceRecipes({
        group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
        carrier: 'rtc',
        typeId: 'receipt-roles',
        senderConnection: 'sender',
        receiverConnection: 'receiver',
        deadlineMs: 18_000,
        laneFamilies: ['three-agent'],
        principalIdsByRole: {}
    }).find((candidate) => candidate.scenarioKey === 'forged-recipient-ack');
    if (scenario?.recipientB === undefined) {
        throw new Error('The generated forged-ACK scenario must declare recipient-b.');
    }
    return { ...scenario, recipientB: scenario.recipientB };
}

/**
 * Every command of the recipe recorded ok; a connect names the session of its role, a receipts read names `lists`, or
 * the lists its command id is given in `listsByCommandId`.
 */
function toRecorded(
    role: string,
    recipe: RallarBlackBoxTestRecipe,
    lists: ReceiptLists,
    listsByCommandId: Readonly<Record<string, ReceiptLists>> = {}
): RecordedAlmConformanceParticipant {
    const results = recipe.commands.map((command): readonly [string, RallarBlackBoxTestResult] => {
        const value = command.kind === 'rtc.connect'
            ? { sessionId: `${role}-session` }
            : command.kind === 'messages.receipts'
            ? listsByCommandId[command.commandId!] ?? lists
            : {};
        return [command.commandId!, {
            commandId: command.commandId!,
            kind: command.kind,
            value,
            ok: true,
            status: 'ok',
            startedAtEpochMs: 1,
            endedAtEpochMs: 2,
            durationMs: 1
        }];
    });
    return {
        participant: { role, agentId: role, commandId: `${role}-root`, recipe, result: undefined },
        results: new Map(results)
    };
}

function assessRetry(carrier: AlmConformanceCarrier, lists: ReceiptLists): readonly string[] {
    const scenario = toRetryScenario(carrier);
    return assessAlmReceiptRoleIdentity({
        sender: toRecorded('sender', scenario.sender, lists),
        recipients: [toRecorded('receiver', scenario.receiver, lists), toRecorded('recipient-b', scenario.recipientB, lists)]
    });
}

/** The forged-ACK sender reads its pinned handle mid-window, then at the end of its window. */
function assessForgedAck(midWindow: ReceiptLists, ending: ReceiptLists): readonly string[] {
    const scenario = toForgedAckScenario();
    const sender = toRecorded('sender', scenario.sender, ending, {
        'alm-rtc-forged-recipient-ack-sender-receipts-mid-window': midWindow
    });
    return assessAlmReceiptRoleIdentity({
        sender,
        recipients: [toRecorded('receiver', scenario.receiver, ending), toRecorded('recipient-b', scenario.recipientB, ending)]
    });
}

const BOTH_CONFIRMED_LISTS = {
    expectedRecipientPeerIds: ['receiver-session', 'recipient-b-session'],
    confirmedRecipientPeerIds: ['recipient-b-session', 'receiver-session'],
    unconfirmedRecipientPeerIds: [],
    outsideAudienceRecipientPeerIds: []
};

const RECEIVER_ONLY_CONFIRMED_LISTS = {
    ...BOTH_CONFIRMED_LISTS,
    confirmedRecipientPeerIds: ['receiver-session'],
    unconfirmedRecipientPeerIds: ['recipient-b-session']
};

const WS_TIMED_OUT = {
    expectedRecipientPeerIds: ['recipient-b-session', 'receiver-session'],
    confirmedRecipientPeerIds: ['receiver-session'],
    unconfirmedRecipientPeerIds: ['recipient-b-session'],
    outsideAudienceRecipientPeerIds: []
};

describe('ALM receipt role identity', () => {
    it('pins the retry receipt per carrier: over ws recipient-b stays unconfirmed, over rtc both recipients confirm', () => {
        expect(toRetryScenario('ws').sender.metadata?.almReceiptRoles).toEqual([
            {
                handleId: 'alm-ws-missing-recipient-retry-send-1',
                confirmed: ['receiver'],
                unconfirmed: ['recipient-b'],
                outsideAudience: []
            }
        ]);
        expect(toRetryScenario('rtc').sender.metadata?.almReceiptRoles).toEqual([
            {
                handleId: 'alm-rtc-missing-recipient-retry-send-1',
                confirmed: ['receiver', 'recipient-b'],
                unconfirmed: [],
                outsideAudience: []
            }
        ]);
        expect(toRetryScenario('rtc').receiver.metadata?.almReceiptRoles).toBeUndefined();
    });

    it('accepts receipt lists that name exactly the sessions of the pinned roles, in any order', () => {
        expect(assessRetry('ws', WS_TIMED_OUT)).toEqual([]);
        expect(assessRetry('rtc', {
            expectedRecipientPeerIds: ['receiver-session', 'recipient-b-session'],
            confirmedRecipientPeerIds: ['recipient-b-session', 'receiver-session'],
            unconfirmedRecipientPeerIds: [],
            outsideAudienceRecipientPeerIds: []
        })).toEqual([]);
    });

    it('rejects a receipt whose counts are right but name the wrong recipient', () => {
        expect(assessRetry('ws', {
            ...WS_TIMED_OUT,
            confirmedRecipientPeerIds: ['recipient-b-session'],
            unconfirmedRecipientPeerIds: ['receiver-session']
        })).toEqual([
            'alm-ws-missing-recipient-retry-send-1: the confirmed recipients do not name the sessions of receiver.',
            'alm-ws-missing-recipient-retry-send-1: the unconfirmed recipients do not name the sessions of recipient-b.'
        ]);
    });

    it('rejects a receipt that expects a session no recipient connected as, such as a late joiner', () => {
        expect(assessRetry('ws', { ...WS_TIMED_OUT, expectedRecipientPeerIds: [...WS_TIMED_OUT.expectedRecipientPeerIds, 'joiner-session'] }))
            .toEqual([
                'alm-ws-missing-recipient-retry-send-1: the expected recipients do not name the sessions of receiver and recipient-b.'
            ]);
    });

    it('fails a malformed receipt role pin instead of skipping its identity check', () => {
        const scenario = toRetryScenario('ws');
        const pins = scenario.sender.metadata?.almReceiptRoles;
        const sender = {
            ...scenario.sender,
            metadata: { ...scenario.sender.metadata, almReceiptRoles: [...(Array.isArray(pins) ? pins : []), { handleId: 7 }] }
        };

        expect(assessAlmReceiptRoleIdentity({
            sender: toRecorded('sender', sender, WS_TIMED_OUT),
            recipients: [toRecorded('receiver', scenario.receiver, WS_TIMED_OUT), toRecorded('recipient-b', scenario.recipientB, WS_TIMED_OUT)]
        })).toEqual(['alm-ws-missing-recipient-retry-sender: 1 receipt role pin(s) do not name a handle and three role lists.']);
    });

    it('expects the recipients outside the audience beside the confirmed and unconfirmed ones', () => {
        const scenario = toRetryScenario('rtc');
        const sender = {
            ...scenario.sender,
            metadata: {
                ...scenario.sender.metadata,
                almReceiptRoles: [{
                    handleId: 'alm-rtc-missing-recipient-retry-send-1',
                    confirmed: ['receiver'],
                    unconfirmed: [],
                    outsideAudience: ['recipient-b']
                }]
            }
        };
        const assess = (lists: ReceiptLists) =>
            assessAlmReceiptRoleIdentity({
                sender: toRecorded('sender', sender, lists),
                recipients: [toRecorded('receiver', scenario.receiver, lists), toRecorded('recipient-b', scenario.recipientB, lists)]
            });
        const outside = {
            expectedRecipientPeerIds: ['receiver-session', 'recipient-b-session'],
            confirmedRecipientPeerIds: ['receiver-session'],
            unconfirmedRecipientPeerIds: [],
            outsideAudienceRecipientPeerIds: ['recipient-b-session']
        };

        expect(assess(outside)).toEqual([]);
        expect(assess({ ...outside, outsideAudienceRecipientPeerIds: [], unconfirmedRecipientPeerIds: ['recipient-b-session'] }))
            .toEqual([
                'alm-rtc-missing-recipient-retry-send-1: the unconfirmed recipients do not name the sessions of no recipient.',
                'alm-rtc-missing-recipient-retry-send-1: the outside-audience recipients do not name the sessions of recipient-b.'
            ]);
    });

    it('joins the receipt the pinned handle ended in when the sender reads it twice', () => {
        expect(assessForgedAck(RECEIVER_ONLY_CONFIRMED_LISTS, BOTH_CONFIRMED_LISTS)).toEqual([]);
    });

    it('fails on the ending read even when an earlier read of the handle shows the declared recipients', () => {
        expect(assessForgedAck(BOTH_CONFIRMED_LISTS, RECEIVER_ONLY_CONFIRMED_LISTS)).toEqual([
            'alm-rtc-forged-recipient-ack-send-1: the confirmed recipients do not name the sessions of receiver and recipient-b.',
            'alm-rtc-forged-recipient-ack-send-1: the unconfirmed recipients do not name the sessions of no recipient.'
        ]);
    });
});
