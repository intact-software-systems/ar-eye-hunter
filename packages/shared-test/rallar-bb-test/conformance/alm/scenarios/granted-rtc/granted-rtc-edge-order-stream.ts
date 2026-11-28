import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestWaitCommand
} from '../../../../rallar-black-box-test-contracts.ts';

import { toHeldMessageFaultCommands, toHeldSendCommands } from '../../alm-conformance-fault-commands.ts';
import { toReachedCommands } from '../../alm-conformance-ordering-commands.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import {
    ALM_CONFORMANCE_GRANTED_TOPIC_ID,
    toCommandId,
    toConnectionName,
    toScenarioTypeId,
    toSendHandleId
} from '../../alm-conformance-step-identities.ts';
import {
    toEdgeOrderArrivalWait,
    toHandedOverAfterAssertion,
    toNoOrderGapWait
} from '../edge-order/edge-order-commands.ts';
import { toGrantedSend } from '../topic-subscription/to-granted-send.ts';
import { SUBSCRIPTION_ABSENCE_MS } from '../topic-subscription/topic-subscription-budgets.ts';
import { TOPIC_SUBSCRIPTION_SELECTOR } from '../topic-subscription/topic-subscription-commands.ts';
import {
    toCueSendCommands,
    toCueWait,
    toPublicationPayload,
    toPublicationWait,
    toPublishUntilConfirmedCommands
} from '../topic-subscription/topic-subscription-publications.ts';
import { GRANTED_RTC_CARRIERS } from './granted-rtc-commands.ts';
import { toPathMemberCommands, toPathOwnerCommands, toPathSenderCommands } from './granted-rtc-path.ts';
import { PATH_START_GRANTS } from './granted-rtc-start-grants.ts';

/** The stream's publications, each named after its place among them. */
const PUBLICATIONS = [1, 2, 3, 4] as const;

/** The publication the cell holds at the sender, and the later one that reaches the receiver first. */
const HELD_PUBLICATION = 2;
const OVERTAKING_PUBLICATION = 3;

/** The probe whose arrival at the receiver's handler says the receiver has started the sender's stream. */
const ENTRY_PROBE = 'probe-entry';

/** Recipient-b's own probe and publications: a second publisher's stream, from the other end of the path. */
const MEMBER_PROBE = 'probe-member';
const MEMBER_PUBLICATIONS = ['b1', 'b2'] as const;

/**
 * A granted room channel that every page declares `order: 'edge'` hands its subscriber one publisher's publications in
 * the order it called `send`, through the publisher proof and the `subscribe` election. The room is a path, as in
 * `granted-rtc-relay-only`: the sender signs each frame with the stamp inside its payload, whichever page the path puts
 * in the middle verifies and forwards it, and the receiver, which alone holds `subscribe` and an election, verifies it
 * and delivers it over RTC.
 *
 * The receiver first starts the stream: a receipted probe is published until the receiver alone confirms it, and the
 * receiver says `entered` once its handler was given that probe, which is after its entry window. Then `p1` is
 * acknowledged, `p2` is held at the sender's own RTC transport, and `p3` is acknowledged while `p2` is still held: a
 * recipient acknowledges at admission, before its sorter, so the receiver holds `p3` and states so. `p2` is released,
 * `p4` follows, and every handle ends `acknowledged`. The receiver's handler is given all four over RTC with the
 * application's own payload, each after the one before it, and the page gives up no position.
 *
 * Recipient-b holds `publish` alone and publishes a stream of its own, `b1` then `b2`, which the receiver's handler is
 * given in that order beside the sender's. A path of three pages has one middle, so unless the receiver is that middle
 * one of the two publishers is a leaf whose frames the other publisher's page verifies and forwards. Recipient-b
 * delivers nothing of the granted topic. Each page records its next hops, which name the layout the run drew; the
 * cell asserts neither which page relays nor the hop count.
 */
export const grantedRtcEdgeOrderStream: AlmConformanceScenarioDefinition = {
    scenarioId: 'granted-rtc-edge-order-stream',
    scenarioKey: 'granted-rtc-edge-order-stream',
    roomTopology: 'reshaped',
    tags: FULL_TAGS,
    carriers: GRANTED_RTC_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    principalRoles: ['receiver', 'recipient-b', 'sender'],
    messageSelector: TOPIC_SUBSCRIPTION_SELECTOR,
    startGrants: PATH_START_GRANTS,
    order: 'edge',
    connect: { minReadyPeers: 1 },
    toSenderCommands: (sender) => toPathSenderCommands(sender, toSwappedStreamCommands(sender)),
    toRecipientCommands: (recipient) =>
        recipient.role === 'receiver'
            ? toPathOwnerCommands(recipient, toSortedStreamCommands(recipient))
            : toPathMemberCommands(recipient, toMemberStreamCommands(recipient))
};

/**
 * The probe rides the stream's first positions: an attempt before the receiver's election holds reaches nobody and
 * completes at once. `p3`'s receipt ends acknowledged before `p2` is released, so `p3` is at the receiver first.
 */
function toSwappedStreamCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const held = { ...sender, index: HELD_PUBLICATION };
    return [
        ...toPublishUntilConfirmedCommands({
            step: sender,
            name: ENTRY_PROBE,
            confirmations: 1,
            outsideAudience: 0,
            kind: 'probe'
        }),
        toCueWait(sender, 'entered'),
        toStreamSend(sender, 1),
        ...toReachedCommands({ ...sender, index: 1 }),
        ...toHeldSendCommands(held, [toStreamSend(sender, HELD_PUBLICATION)]),
        toStreamSend(sender, OVERTAKING_PUBLICATION),
        ...toReachedCommands({ ...sender, index: OVERTAKING_PUBLICATION }),
        ...toHeldMessageFaultCommands(held, `release-message-${HELD_PUBLICATION}`, 0),
        toStreamSend(sender, 4),
        ...[HELD_PUBLICATION, 4].flatMap((index) => toReachedCommands({ ...sender, index })),
        toCueWait(sender, 'received')
    ];
}

/**
 * The receiver's handler was given the sender's probe, so its page has started that stream; from its `entered` cue on,
 * the page states that it held an arrival of that sender for its turn, which is `p3` behind `p2`. Its handler was then
 * given every publication of each publisher over RTC, each after the one its publisher sent before it, and the page
 * gave up no position of any stream of the cell's type.
 */
function toSortedStreamCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const entered = toCueSendCommands(receiver, 'entered');
    const held = toEdgeOrderArrivalWait(receiver, 'held-overtaking-publication', 'held');
    return [
        toRtcArrival(toProbeWait(receiver, ENTRY_PROBE)),
        ...entered,
        {
            ...held,
            match: {
                ...held.match,
                contains: `"senderId":"${toProbeSenderId(receiver)}"`,
                sinceCommandIdPrefix: toCommandId(receiver, 'cue-entered')
            }
        },
        ...PUBLICATIONS.map((index) => toRtcArrival(toPublicationWait(receiver, toPublicationName(index), false))),
        ...PUBLICATIONS.slice(1).map((index) =>
            toHandedOverAfterAssertion(receiver, toPublicationName(index), toPublicationName(index - 1))
        ),
        ...MEMBER_PUBLICATIONS.map((publication) => toRtcArrival(toPublicationWait(receiver, publication, false))),
        toHandedOverAfterAssertion(receiver, MEMBER_PUBLICATIONS[1], MEMBER_PUBLICATIONS[0]),
        toNoOrderGapWait(receiver)
    ];
}

/**
 * Recipient-b publishes once the owner cued `start`, so the receiver's election holds: its probe is published until the
 * receiver alone confirms it, then `b1` and `b2` each end acknowledged. It hears the owner's `received` and has
 * recorded nothing of the granted topic itself.
 */
function toMemberStreamCommands(member: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toCueWait(member, 'start'),
        ...toPublishUntilConfirmedCommands({
            step: member,
            name: MEMBER_PROBE,
            confirmations: 1,
            outsideAudience: 0,
            kind: 'probe'
        }),
        ...MEMBER_PUBLICATIONS.flatMap((publication, at) => [
            toNamedStreamSend(member, at + 1, publication),
            ...toReachedCommands({ ...member, index: at + 1 })
        ]),
        toCueWait(member, 'received'),
        toNoGrantedArrivalWait(member)
    ];
}

/** One receipted publication of the sender's stream, named as the hold and the receipt waits name it. */
function toStreamSend(sender: AlmConformanceStepInput, index: number): RallarBlackBoxTestCommand {
    return toNamedStreamSend(sender, index, toPublicationName(index));
}

/** The `index`-th receipted publication of the step's own stream, whose payload names it `publication`. */
function toNamedStreamSend(
    step: AlmConformanceStepInput,
    index: number,
    publication: string
): RallarBlackBoxTestCommand {
    return {
        ...toGrantedSend({ step, payload: toPublicationPayload(step, publication, 'publication') }),
        commandId: toCommandId(step, `send-${index}`),
        handleId: toSendHandleId({ ...step, index })
    };
}

/** A probe's arrival on the page, waited for as a publication's is: only a page whose handler is given the topic records one. */
function toProbeWait(step: AlmConformanceStepInput, probe: string): RallarBlackBoxTestWaitCommand {
    const wait = toPublicationWait(step, probe, false);
    return { ...wait, match: { ...wait.match, equals: toPublicationPayload(step, probe, 'probe') } };
}

/** The wait's arrival came over RTC: only the receiver's own election is given a granted RTC copy. */
function toRtcArrival(wait: RallarBlackBoxTestWaitCommand): RallarBlackBoxTestWaitCommand {
    return { ...wait, match: { ...wait.match, payloadFields: { 'data.transport': 'rtc' } } };
}

/** The sender's session, read from the probe the receiver was given: recipient-b's stream can be held at its entry. */
function toProbeSenderId(receiver: AlmConformanceStepInput): string {
    return `{resultCache.${toCommandId(receiver, `received-${ENTRY_PROBE}`)}.value.event.payload.senderId}`;
}

/**
 * The page recorded no message of the cell's type on the granted topic, whatever its payload: a page that never opened
 * the channel would be given a copy with the order wrapper still around it, which no payload wait names.
 */
function toNoGrantedArrivalWait(recipient: AlmConformanceStepInput): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(recipient, 'absent-granted-arrival'),
        match: {
            kind: 'message',
            connection: toConnectionName(recipient),
            payloadFields: {
                'data.typeId': toScenarioTypeId(recipient),
                'data.topicId': ALM_CONFORMANCE_GRANTED_TOPIC_ID
            }
        },
        absent: true,
        timeoutMs: SUBSCRIPTION_ABSENCE_MS
    };
}

function toPublicationName(index: number): string {
    return `p${index}`;
}
