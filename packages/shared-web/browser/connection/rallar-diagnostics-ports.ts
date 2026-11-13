import type { ALInboundRuntimeDiagnosticsSink } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import type { ALOutboundRuntimeDiagnosticsSink } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    createPassThroughALStorageEventSink,
    type ALStorageEventSink
} from '@shared/alm/storage/al-storage-event.ts';
import {
    createPassThroughIndexedDbOperationObserver,
    type IndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import {
    createPassThroughGroupStateSnapshotChangeSink,
    type GroupStateSnapshotChangeSink
} from '@shared/repository/group-state-snapshot-change-sink.ts';
import {
    createPassThroughTransportFaultPort,
    createPassThroughWebSocketSubmissionReadinessFaultPort,
    type TransportFaultPort,
    type WebSocketSubmissionReadinessFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

export interface RallarDiagnosticsPortsInput {
    readonly submissionReadinessFaultPort?: WebSocketSubmissionReadinessFaultPort;
    readonly transportFaultPort?: TransportFaultPort;
    readonly indexedDbOperationObserver?: IndexedDbOperationObserver;
    readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
    readonly inboundDiagnostics?: ALInboundRuntimeDiagnosticsSink;
    readonly storage?: ALStorageEventSink;
    readonly signalingDiagnostics?: RtcSignalingDiagnostics['record'];
    /** Where the connect's group cache hands each raw change of what it holds. */
    readonly groupStateDiagnostics?: GroupStateSnapshotChangeSink;
}

export interface RallarDiagnosticsPorts {
    readonly submissionReadinessFaultPort: WebSocketSubmissionReadinessFaultPort;
    readonly transportFaultPort: TransportFaultPort;
    readonly indexedDbOperationObserver: IndexedDbOperationObserver;
    readonly outboundDiagnostics: ALOutboundRuntimeDiagnosticsSink;
    readonly inboundDiagnostics: ALInboundRuntimeDiagnosticsSink;
    readonly storage: ALStorageEventSink;
    readonly signalingDiagnostics?: RtcSignalingDiagnostics['record'];
    readonly groupStateDiagnostics: GroupStateSnapshotChangeSink;
}

export function createPassThroughALOutboundRuntimeDiagnosticsSink(): ALOutboundRuntimeDiagnosticsSink {
    return () => {};
}

export function createPassThroughALInboundRuntimeDiagnosticsSink(): ALInboundRuntimeDiagnosticsSink {
    return () => {};
}

export function toRallarDiagnosticsPorts(
    input: RallarDiagnosticsPortsInput | undefined
): RallarDiagnosticsPorts {
    return {
        submissionReadinessFaultPort: input?.submissionReadinessFaultPort ??
            createPassThroughWebSocketSubmissionReadinessFaultPort(),
        transportFaultPort: input?.transportFaultPort ?? createPassThroughTransportFaultPort(),
        indexedDbOperationObserver: input?.indexedDbOperationObserver ??
            createPassThroughIndexedDbOperationObserver(),
        outboundDiagnostics: input?.outboundDiagnostics ?? createPassThroughALOutboundRuntimeDiagnosticsSink(),
        inboundDiagnostics: input?.inboundDiagnostics ?? createPassThroughALInboundRuntimeDiagnosticsSink(),
        storage: input?.storage ?? createPassThroughALStorageEventSink(),
        signalingDiagnostics: input?.signalingDiagnostics,
        groupStateDiagnostics: input?.groupStateDiagnostics ?? createPassThroughGroupStateSnapshotChangeSink()
    };
}
