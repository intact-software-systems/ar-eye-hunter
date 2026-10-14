import type { AsyncCommandTimeoutEvent } from '../cache/AsyncCommand.ts';
import { toRtcObserved, toRtcUnavailable } from '../webrtc/rtc-native-observation-values.ts';
import type { RtcSignalingDiagnostics } from '../webrtc/rtc-signaling-diagnostics.ts';
import type { WebRtcConnectionService } from './web-rtc-connection-service.ts';

export interface RtcServiceSetupRow extends RtcSignalingDiagnostics.SignalIdentity {
    readonly kind: 'service-peer-observation';
    readonly service: RtcSignalingDiagnostics.ServiceSetupObservation;
}
export interface RtcServiceTerminationRow extends RtcSignalingDiagnostics.SignalIdentity {
    readonly kind: 'service-peer-observation';
    readonly service: RtcSignalingDiagnostics.ServiceTerminationObservation;
}
export interface RtcServiceTimeoutRow extends RtcSignalingDiagnostics.SignalIdentity {
    readonly kind: 'service-peer-observation';
    readonly service: RtcSignalingDiagnostics.ServiceTimeoutObservation;
}
export interface RtcServiceTimeoutInput {
    readonly identity: RtcSignalingDiagnostics.SignalIdentity;
    readonly snapshot: RtcSignalingDiagnostics.ServicePeerSnapshot;
    readonly event: WebRtcConnectionService.PeerEstablishmentTimeoutEvent;
    readonly watch: AsyncCommandTimeoutEvent<string>;
}

export function toRtcServiceSetupObservation(
    identity: RtcSignalingDiagnostics.SignalIdentity,
    snapshot: RtcSignalingDiagnostics.ServicePeerSnapshot,
    stage: 'setup-started' | 'setup-established'
): RtcServiceSetupRow {
    return Object.freeze({
        ...identity,
        kind: 'service-peer-observation',
        service: Object.freeze({
            ...snapshot,
            stage,
            issuer: toRtcUnavailable('not-applicable'),
            timeout: toRtcUnavailable('not-applicable')
        })
    });
}

export function toRtcServiceTerminationObservation(
    identity: RtcSignalingDiagnostics.SignalIdentity,
    snapshot: RtcSignalingDiagnostics.ServicePeerSnapshot,
    issuer: RtcSignalingDiagnostics.TerminationIssuer
): RtcServiceTerminationRow {
    return Object.freeze({
        ...identity,
        kind: 'service-peer-observation',
        service: Object.freeze({
            ...snapshot,
            stage: 'terminating',
            issuer: toRtcObserved(issuer),
            timeout: toRtcUnavailable('not-applicable')
        })
    });
}

export function toRtcServiceTimeoutObservation(input: RtcServiceTimeoutInput): RtcServiceTimeoutRow {
    return Object.freeze({
        ...input.identity,
        kind: 'service-peer-observation',
        service: Object.freeze({
            ...input.snapshot,
            stage: 'establishment-timeout',
            issuer: toRtcObserved('establishment-timeout' as const),
            timeout: toRtcObserved(Object.freeze({ ...input.event })),
            watchStartedAtEpochMs: input.watch.startedAtEpochMs,
            watchTimedOutAtEpochMs: input.watch.timedOutAtEpochMs,
            removalDisposition: 'original-no-longer-current'
        })
    });
}
