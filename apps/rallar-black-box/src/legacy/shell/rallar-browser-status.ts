import { selectRallarBlackBoxEvents } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import { eventPayloadDetails, isRallarBrowserEvent } from '../diagnostics/events/event-presentation.ts';
import { optionalNumber } from '../shared/finite-number.ts';
import { recordValue as optionalRecord } from '../shared/record-value.ts';
import { stringValue } from '../shared/string-value.ts';
import type { CommandCenterGlobalValues } from './global-context-model.ts';

export type RallarBrowserStatusSummary = Readonly<{
    signalingLabel: string;
    signalingTone: string;
    signalingDetail: string;
    rtcLabel: string;
    rtcTone: string;
    rtcDetail: string;
    rtcGroup: string;
    rtcConnection: string;
    rtcTransport: string;
    peerSummary: string;
    latestTopic?: string;
    latestAtEpochMs?: number;
    rallarConnected?: boolean;
}>;

function looksLikeWsStatus(value: Record<string, unknown>): boolean {
    return (
        'readyState' in value ||
        'isOpen' in value ||
        'connectState' in value ||
        'reconnecting' in value
    );
}

function looksLikeRtcStatus(value: Record<string, unknown>): boolean {
    return (
        'knownPeerIds' in value ||
        'activePeerIds' in value ||
        'readyPeerIds' in value ||
        'peerIdsWithNoReconnectableLanes' in value ||
        'peers' in value ||
        'laneId' in value
    );
}

function wsStatusFromDetails(
    details: Record<string, unknown>
): Record<string, unknown> | undefined {
    const explicit = optionalRecord(details.wsStatus);
    if (looksLikeWsStatus(explicit)) {
        return explicit;
    }
    const nestedStatus = optionalRecord(details.status);
    return looksLikeWsStatus(nestedStatus) ? nestedStatus : undefined;
}

function rtcStatusFromDetails(
    details: Record<string, unknown>
): Record<string, unknown> | undefined {
    const explicit = optionalRecord(details.rtcStatus);
    if (looksLikeRtcStatus(explicit)) {
        return explicit;
    }
    const nestedStatus = optionalRecord(details.status);
    return looksLikeRtcStatus(nestedStatus) ? nestedStatus : undefined;
}

function arrayCount(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

function deriveWsStatusLabel(
    status?: Record<string, unknown>
): Pick<RallarBrowserStatusSummary, 'signalingLabel' | 'signalingTone' | 'signalingDetail'> {
    if (!status) {
        return {
            signalingLabel: 'not observed',
            signalingTone: 'muted',
            signalingDetail: '-'
        };
    }

    const readyState = stringValue(status.readyState);
    const connectState = stringValue(status.connectState);
    const reconnecting = status.reconnecting === true;
    const reconnectExhausted = status.reconnectExhausted === true;
    const label = reconnectExhausted
        ? 'exhausted'
        : reconnecting
        ? 'reconnecting'
        : status.isOpen === true || readyState === 'open'
        ? 'open'
        : (readyState ?? connectState ?? 'unknown');
    const tone = label === 'open'
        ? 'good'
        : label === 'connecting' || label === 'reconnecting'
        ? 'active'
        : label === 'closed' ||
                label === 'closing' ||
                label === 'exhausted'
        ? 'warn'
        : 'muted';
    const attempts = optionalNumber(status.reconnectAttempts);
    const maxAttempts = optionalNumber(status.maxReconnectAttempts);

    return {
        signalingLabel: label,
        signalingTone: tone,
        signalingDetail: [
            connectState,
            attempts !== undefined
                ? `${attempts}/${maxAttempts ?? '-'} reconnects`
                : undefined
        ]
            .filter((value): value is string => Boolean(value && value.length > 0))
            .join(' - ') || '-'
    };
}

function deriveRtcStatusLabel(
    status: Record<string, unknown> | undefined,
    latestDetails: Record<string, unknown> | undefined,
    latestTopic?: string
): Pick<RallarBrowserStatusSummary, 'rtcLabel' | 'rtcTone' | 'peerSummary' | 'rallarConnected'> {
    const readyPeers = arrayCount(status?.readyPeerIds);
    const activePeers = arrayCount(status?.activePeerIds);
    const knownPeers = arrayCount(status?.knownPeerIds);
    const noReconnectable = arrayCount(status?.peerIdsWithNoReconnectableLanes);
    const rallarConnected = latestDetails?.rallarConnected === true ||
        stringValue(latestDetails?.status) === 'connected';
    const closed = latestTopic?.includes('closed') === true ||
        latestTopic?.includes('disconnect_completed') === true;
    const label = closed
        ? 'closed'
        : readyPeers > 0
        ? 'ready'
        : activePeers > 0
        ? 'active'
        : knownPeers > 0
        ? 'peers known'
        : rallarConnected
        ? 'connected'
        : status
        ? 'no peers'
        : 'not observed';
    const tone = label === 'ready' || label === 'active' || label === 'connected'
        ? 'good'
        : label === 'peers known' || label === 'no peers'
        ? 'warn'
        : label === 'closed'
        ? 'muted'
        : 'muted';

    return {
        rtcLabel: label,
        rtcTone: noReconnectable > 0 ? 'warn' : tone,
        peerSummary: `ready ${readyPeers} / active ${activePeers} / known ${knownPeers}`,
        rallarConnected
    };
}

export function deriveRallarBrowserStatus(
    state: RallarBlackBoxTestState,
    globalValues?: CommandCenterGlobalValues
): RallarBrowserStatusSummary {
    const events = selectRallarBlackBoxEvents(state).filter(isRallarBrowserEvent);
    const latestEvent = events.at(-1);
    const latestDetails = latestEvent
        ? eventPayloadDetails(latestEvent)
        : undefined;
    const latestWsStatus = events
        .map((event) => wsStatusFromDetails(eventPayloadDetails(event)))
        .findLast(Boolean);
    const latestRtcEvent = events.findLast((event) => {
        const details = eventPayloadDetails(event);
        return (
            Boolean(rtcStatusFromDetails(details)) ||
            event.topic.includes('connect_completed') ||
            event.topic.includes('closed') ||
            event.topic.includes('rtc.lifecycle')
        );
    });
    const latestRtcDetails = latestRtcEvent
        ? eventPayloadDetails(latestRtcEvent)
        : latestDetails;
    const latestRtcStatus = latestRtcDetails
        ? rtcStatusFromDetails(latestRtcDetails)
        : undefined;
    const ws = deriveWsStatusLabel(latestWsStatus);
    const rtc = deriveRtcStatusLabel(
        latestRtcStatus,
        latestRtcDetails,
        latestRtcEvent?.topic
    );
    const group = stringValue(latestRtcDetails?.roomId) ??
        stringValue(optionalRecord(latestRtcDetails?.roomRef).groupId) ??
        globalValues?.roomId ??
        state.currentConfig?.roomId ??
        '-';

    return {
        ...ws,
        ...rtc,
        rtcDetail: stringValue(latestRtcDetails?.laneId) ??
            stringValue(latestRtcDetails?.typeId) ??
            '-',
        rtcGroup: group,
        rtcConnection: latestRtcEvent?.connection ??
            String(state.currentConfig?.defaults?.connection ?? 'default'),
        rtcTransport: latestRtcEvent?.transport ?? state.currentConfig?.transport ?? '-',
        latestTopic: latestEvent?.topic,
        latestAtEpochMs: latestEvent?.atEpochMs
    };
}
