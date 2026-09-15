import { AL_DELIVERY_STATES } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { RallarBlackBoxCommandCapability } from '../rallar-black-box-test-contracts.ts';
export const RALLAR_BLACK_BOX_ALM_COMMAND_CAPABILITIES: readonly RallarBlackBoxCommandCapability[] = [
    {
        kind: 'messages.send',
        title: 'Send ALM Message',
        description:
            'Sends an ALM-addressed message over ws, rtc, or rtc-with-ws-fallback and returns delivery status.',
        requiredFields: ['carrier', 'typeId', 'payload'],
        optionalFields: [
            'connection',
            'topicId',
            'roomRef',
            'scope',
            'reliability',
            'ack',
            'ttlMs',
            'orderingKey',
            'seq',
            'handleId',
            'commandId',
            'label',
            'timeoutMs',
            'deadlineEpochMs',
            'metadata'
        ],
        supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
        runtimeSurfaces: ['spa-local', 'control-agent'],
        liveServiceRequirements: ['api-v1'],
        artifactExpectations: ['send result with handleId, carrier, and admission status'],
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
            'The in-page handle projects admission, carrier attempts and hop acknowledgements; a lost handle is unobservable.',
        requiredFields: ['handleId', 'state'],
        optionalFields: ['connection', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
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
        requiredFields: ['handleId'],
        optionalFields: ['connection', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
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
        requiredFields: ['typeId', 'count', 'windowMs'],
        optionalFields: [
            'connection',
            'msgId',
            'absent',
            'commandId',
            'label',
            'timeoutMs',
            'deadlineEpochMs',
            'metadata'
        ],
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
        description:
            'Reads the in-page lifecycle observation for a messages.send handle, including confirmedHopPeerIds, ' +
            'unconfirmedHopPeerIds, attempts, submission facts and reason. Unknown handles are unobservable.',
        requiredFields: ['handleId'],
        optionalFields: ['connection', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
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
        kind: 'fault.inject',
        title: 'Inject Transport Fault',
        description:
            'Schedules a scripted drop or delay for matching ws/rtc traffic, bounded by a remaining-match count.',
        requiredFields: ['faultId', 'carrier', 'match', 'action', 'remaining'],
        optionalFields: ['commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
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
        requiredFields: [],
        optionalFields: ['reset', 'commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
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
        requiredFields: ['readyTimeoutMs'],
        optionalFields: ['commandId', 'label', 'timeoutMs', 'deadlineEpochMs', 'metadata'],
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
