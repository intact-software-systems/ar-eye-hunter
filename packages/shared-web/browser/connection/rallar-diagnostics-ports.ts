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
    createPassThroughTransportFaultPort,
    createPassThroughWebSocketSubmissionReadinessFaultPort,
    type TransportFaultPort,
    type WebSocketSubmissionReadinessFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';

export interface RallarDiagnosticsPortsInput {
    readonly submissionReadinessFaultPort?: WebSocketSubmissionReadinessFaultPort;
    readonly transportFaultPort?: TransportFaultPort;
    readonly indexedDbOperationObserver?: IndexedDbOperationObserver;
    readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
    readonly inboundDiagnostics?: ALInboundRuntimeDiagnosticsSink;
    readonly storage?: ALStorageEventSink;
}

export interface RallarDiagnosticsPorts {
    readonly submissionReadinessFaultPort: WebSocketSubmissionReadinessFaultPort;
    readonly transportFaultPort: TransportFaultPort;
    readonly indexedDbOperationObserver: IndexedDbOperationObserver;
    readonly outboundDiagnostics: ALOutboundRuntimeDiagnosticsSink;
    readonly inboundDiagnostics: ALInboundRuntimeDiagnosticsSink;
    readonly storage: ALStorageEventSink;
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
        storage: input?.storage ?? createPassThroughALStorageEventSink()
    };
}
