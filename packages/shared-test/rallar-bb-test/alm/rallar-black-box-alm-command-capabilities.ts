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
            'minSnapshotVersion states a room snapshot floor, absolute or aboveCurrentBy the sender\'s version at ' +
            'send time. qos: { ack: { algo } } passes a QoS ack algorithm request (none, hop, subtree, receiver) to ' +
            'the product as given. A replay names only replayOnCarrier (and connection): a harness capability the ' +
            'product never exercises, it re-admits the envelope an earlier handle\'s first carrier captured on the ' +
            'other carrier, opens no handle, and returns that admission verdict.',
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
            'The in-page handle projects admission, carrier attempts with their attemptOutcomes, a relayRejection, and the ' +
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
            'unconfirmedRecipientPeerIds, attempts, attemptOutcomes, relayRejection, submission facts and reason. ' +
            'Unknown handles are unobservable.',
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
        kind: 'fault.inject',
        title: 'Inject Transport Fault',
        description: 'Schedules a drop for matching WS/RTC traffic, or WS-only delay or not-ready submission faults. ' +
            'remaining is a finite match count or until-cleared; replacing the same faultId with remaining:0 releases it.',
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
