import { AL_DELIVERY_STATES } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { RallarBlackBoxCommandCapability } from '../rallar-black-box-test-contracts.ts';

export const RALLAR_BLACK_BOX_ALM_COMMAND_CAPABILITIES: readonly Omit<
    RallarBlackBoxCommandCapability,
    'requiredFields' | 'optionalFields'
>[] = [
    {
        kind: 'messages.send',
        title: 'Send ALM Message',
        description:
            'Sends an ALM-addressed message over ws, rtc, or rtc-with-ws-fallback and returns delivery status. ' +
            'purpose (command, notification, live) names the typed channel the page opens; absent, a toPeer send ' +
            'opens a command channel and any other a notification one. publication { cadenceMs, retainNewest, ' +
            'drain: { messages, bytes } } is a live channel\'s pacing, required with purpose live and refused with ' +
            'any other; a live send names resourceId, its stream, and returns once staged. ' +
            'minSnapshotVersion states a room snapshot floor, absolute or aboveCurrentBy the sender\'s version at ' +
            'send time. qos: { ack: { algo } } passes a QoS ack algorithm request (none, hop, subtree, receiver) to ' +
            'the product as given. durability (volatile, local-checkpoint, local-outbox, local-inbox) declares the ' +
            'typed channel\'s ' +
            'durability; absent, the send is volatile. onStorageUnavailable (refuse, volatile) declares what the ' +
            'channel does when its durable storage is unavailable; absent, it refuses. ' +
            'toPeer (server or receiver) addresses one peer by its lane role, which the page resolves at send time to ' +
            'the WS server\'s peer id or to the one other live session of the room; a role it cannot resolve fails ' +
            'the send and opens no handle. scope (room, world, principal) names the audience; with principal, ' +
            'principalId names the principal whose live sessions in the room it reaches. recipientPeer (receiver, ' +
            'recipient-b) names a fixed audience of one inside the room by lane role, which the page resolves at send ' +
            'time among the room\'s other live sessions whose principal is not the sender\'s: receiver to the one such ' +
            'session, recipient-b to the one that is not the room\'s leader; a role it cannot resolve fails the send ' +
            'and opens no handle. ownership (shared, exclusive) passes the send\'s ownership to the product as given; ' +
            'resourceId names the route\'s resource, which an exclusive send claims for the sending session; absent, ' +
            'the product mints a fresh resource per send. ' +
            'A replay names only replayOnCarrier (and connection): a ' +
            'harness capability the product never exercises, it re-admits the envelope an earlier handle\'s first ' +
            'carrier captured on the other carrier, opens no handle, and returns that admission verdict.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['api-v1'],
        artifactExpectations: [
            'send result with handleId, carrier, and admission status',
            'replay result with handleId, msgId, carrier, and admission verdict'
        ],
        example: {
            kind: 'messages.send',
            commandId: 'send-alm-message',
            carrier: 'ws',
            typeId: 'alm.conformance',
            payload: { n: 1 },
            handleId: 'alm-send-1'
        }
    },
    {
        kind: 'messages.observe',
        title: 'Observe ALM Send',
        description: 'Waits for a prior messages.send handle to reach one of the given delivery states. ' +
            `The shared states are ${AL_DELIVERY_STATES.join(', ')}. ` +
            'The in-page handle projects admission, carrier attempts with their attemptOutcomes, attemptCarriers and attemptRefusalReasons, a relayRejection, ' +
            'a carrierFallback, the typed failure of a send that ended rejected, failed or expired, and the ' +
            'latest receipt: its receiptMode, the hop lists, and expectedRecipientPeerIds, confirmedRecipientPeerIds and ' +
            'unconfirmedRecipientPeerIds beside them; a lost handle is unobservable.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['api-v1'],
        artifactExpectations: ['observed delivery state', 'submitted flag and attempt count'],
        example: {
            kind: 'messages.observe',
            commandId: 'observe-alm-send',
            handleId: 'alm-send-1',
            state: ['accepted']
        }
    },
    {
        kind: 'messages.cancel',
        title: 'Cancel ALM Send',
        description: 'Stops the owner remaining attempts for a live messages.send handle. ' +
            'Terminal evidence is preserved; cancellation does not recall a submitted frame.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['api-v1'],
        artifactExpectations: ['cancel result for the handle'],
        example: {
            kind: 'messages.cancel',
            commandId: 'cancel-alm-send',
            handleId: 'alm-send-1'
        }
    },
    {
        kind: 'messages.received',
        title: 'Assert ALM Messages Received',
        description: 'Counts messages of a typeId (optionally one msgId) on the whole inbound event log and ' +
            'compares against an expected count. A presence claim settles as soon as the count is ' +
            'reached; absent holds the whole windowMs and then passes only if fewer than count ' +
            '(at least one) arrived.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['api-v1'],
        artifactExpectations: ['received-count result', 'window evaluation diagnostics'],
        example: {
            kind: 'messages.received',
            commandId: 'assert-alm-received',
            typeId: 'alm.conformance',
            count: 1,
            windowMs: 5_000
        }
    },
    {
        kind: 'messages.receipts',
        title: 'Read ALM Receipts',
        description: 'Reads the in-page lifecycle observation for a messages.send handle, including receiptMode, ' +
            'confirmedHopPeerIds, unconfirmedHopPeerIds, expectedRecipientPeerIds, confirmedRecipientPeerIds, ' +
            'unconfirmedRecipientPeerIds, attempts, attemptOutcomes, attemptCarriers, attemptRefusalReasons, relayRejection, carrierFallback, failure, ' +
            'submission facts and reason. Unknown handles are unobservable.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['api-v1'],
        artifactExpectations: ['ledger observation for the handle'],
        example: {
            kind: 'messages.receipts',
            commandId: 'read-alm-receipts',
            handleId: 'alm-send-1'
        }
    },
    {
        kind: 'messages.control',
        title: 'Submit Raw ALM Control',
        description: 'Harness-only: submits, as msgId, the ACK of ackedMsgId to its sender toPeerId under an ' +
            'al.control.* typeId, through the carrier admission a product control takes; returns the carrier verdict.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['api-v1'],
        artifactExpectations: ['control msgId and carrier admission verdict'],
        example: {
            kind: 'messages.control',
            commandId: 'submit-unknown-ack-version',
            carrier: 'rtc',
            typeId: 'al.control.ack.v1',
            msgId: 'retired-ack-1',
            ackedMsgId: 'received-msg-id',
            toPeerId: 'origin-session-id'
        }
    },
    {
        kind: 'messages.awaitReply',
        title: 'Await ALM Reply',
        description:
            'Waits for the one reply to a prior messages.send handle, matched on its replyToMsgId. The value ' +
            'is payload-free: status (replied, timeout, aborted, undelivered), the request\'s state and corrId, and ' +
            'for replied the reply\'s msgId, replyToMsgId, corrId, senderId and typeId. The page ends the wait 250 ms ' +
            'before timeoutMs, so a timeout is the command\'s value, never its failure; the first timeout ends every ' +
            'wait of the request, and a later reply is dropped as reply-late. Replies travel over WS only.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['api-v1'],
        artifactExpectations: ['reply wait outcome with the request state and correlation, and the reply identity'],
        example: {
            kind: 'messages.awaitReply',
            commandId: 'await-alm-reply',
            handleId: 'alm-send-1',
            timeoutMs: 5_000
        }
    },
    {
        kind: 'messages.reply',
        title: 'Reply to ALM Message',
        description: 'Replies with payload to the index-th arrival (1-based) of typeId among the last 16 the page ' +
            'received of that type: a WS unicast to the request\'s sender session under the request\'s correlation, ' +
            'in its room. handleId names the reply\'s own handle, so messages.observe follows its delivery. An arrival ' +
            'the page does not hold fails the command and sends nothing.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['api-v1'],
        artifactExpectations: ['reply handle with its msgId and replyToMsgId'],
        example: {
            kind: 'messages.reply',
            commandId: 'reply-alm-message',
            typeId: 'alm.conformance',
            index: 1,
            payload: { ok: true },
            handleId: 'alm-reply-1'
        }
    },
    {
        kind: 'messages.subscribe',
        title: 'Subscribe Granted Topic',
        description:
            'Elects the page\'s session to receive the granted room topic its connection\'s message selector ' +
            'names (access granted) and keeps the token under subscriptionId. Returns once the token leaves pending ' +
            'or 250 ms before timeoutMs: status pending, active, refused or lapsed. The token\'s handler does nothing; ' +
            'the connect\'s own subscription records every delivery, which messages.received counts.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['api-v1'],
        artifactExpectations: ['subscriptionId and the token status'],
        example: {
            kind: 'messages.subscribe',
            commandId: 'subscribe-granted-topic',
            subscriptionId: 'granted-1'
        }
    },
    {
        kind: 'messages.unsubscribe',
        title: 'Unsubscribe Granted Topic',
        description: 'Releases the token the page holds under subscriptionId and returns its status, lapsed once ' +
            'released; the last token of a topic releases the session\'s subscription on the server.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['api-v1'],
        artifactExpectations: ['subscriptionId and the token status'],
        example: {
            kind: 'messages.unsubscribe',
            commandId: 'unsubscribe-granted-topic',
            subscriptionId: 'granted-1'
        }
    },
    {
        kind: 'messages.subscriptions',
        title: 'Read Granted Topic Subscriptions',
        description: 'Reads every token the page holds, each with its subscriptionId, topicId and status, and the ' +
            'open product socket\'s connection generation, null while the socket is closed.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['api-v1'],
        artifactExpectations: ['connectionGenerationId and the held tokens'],
        example: {
            kind: 'messages.subscriptions',
            commandId: 'read-granted-subscriptions'
        }
    },
    {
        kind: 'fault.inject',
        title: 'Inject Transport or Storage Fault',
        description: 'Schedules a drop for matching WS/RTC traffic, or WS-only delay or not-ready submission faults. ' +
            'backpressure, on either carrier, makes the carrier read its channel as at its high watermark when it ' +
            'plans each matching origination, so the send meets its congestion policy: a best-effort send is refused ' +
            'congested or handed to WS under rtc-with-ws-fallback, an at-least-once send settles not-ready and retries. ' +
            'match.msgId may name a {resultCache.<commandId>.<path>} token, such as the msgId an earlier ' +
            'messages.send returned, so one message is held while every other frame of its type passes. ' +
            'carrier storage instead faults the IndexedDB operations of match.owner (al-admission or al-work) and ' +
            'optionally match.kind: fail, quota (writes only) or a delay. ' +
            'remaining is a finite match count or until-cleared; replacing the same faultId with remaining:0 releases it. ' +
            'carrier product-socket names neither match nor remaining: action close closes the page\'s product socket ' +
            'with reconnect disabled, and reopen enables reconnect and opens a new authorised socket, whose connection ' +
            'generation is new.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [],
        artifactExpectations: ['fault registration result'],
        example: {
            kind: 'fault.inject',
            commandId: 'inject-nack-drop',
            faultId: 'drop-one-nack',
            carrier: 'ws',
            match: { controlType: 'nack' },
            action: 'drop',
            remaining: 1
        }
    },
    {
        kind: 'storage.counters',
        title: 'Read Storage Counters',
        description: 'Reads (and optionally resets) the AL-owned IndexedDB operation counters by owner ' +
            '(al-admission, al-work) and by operation kind. The scripted storage observer is only ' +
            'attached when the active connection names an application.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [],
        artifactExpectations: ['total/byOwner/byKind storage counters'],
        example: {
            kind: 'storage.counters',
            commandId: 'read-storage-counters'
        }
    },
    {
        kind: 'agent.reload',
        title: 'Reload Agent',
        description: 'Asks the control agent to reload its page and resume the run when it is ready again. ' +
            'On the spa-local surface nothing reloads and the command only records the request.',
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: [],
        artifactExpectations: ['reload readiness result'],
        example: {
            kind: 'agent.reload',
            commandId: 'reload-agent',
            readyTimeoutMs: 10_000
        }
    }
];
