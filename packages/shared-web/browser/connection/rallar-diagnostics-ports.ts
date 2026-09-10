import type { ALStorageResetEvent } from '@shared/alm/open-indexed-db-admission-database.ts';
import type { ALOutboundRuntimeDiagnosticsSink } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    createPassThroughIndexedDbOperationObserver,
    type IndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import {
    createPassThroughTransportFaultPort,
    type TransportFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';

export interface RallarDiagnosticsPortsInput {
    readonly transportFaultPort?: TransportFaultPort;
    readonly indexedDbOperationObserver?: IndexedDbOperationObserver;
    readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
    readonly onStorageReset?: (event: ALStorageResetEvent) => void;
}

export interface RallarDiagnosticsPorts {
    readonly transportFaultPort: TransportFaultPort;
    readonly indexedDbOperationObserver: IndexedDbOperationObserver;
    readonly outboundDiagnostics: ALOutboundRuntimeDiagnosticsSink;
    readonly onStorageReset: (event: ALStorageResetEvent) => void;
}

export function createPassThroughALOutboundRuntimeDiagnosticsSink(): ALOutboundRuntimeDiagnosticsSink {
    return () => {};
}

export function createPassThroughALStorageResetSink(): (event: ALStorageResetEvent) => void {
    return () => {};
}

export function toRallarDiagnosticsPorts(
    input: RallarDiagnosticsPortsInput | undefined
): RallarDiagnosticsPorts {
    return {
        transportFaultPort: input?.transportFaultPort ?? createPassThroughTransportFaultPort(),
        indexedDbOperationObserver: input?.indexedDbOperationObserver ??
            createPassThroughIndexedDbOperationObserver(),
        outboundDiagnostics: input?.outboundDiagnostics ?? createPassThroughALOutboundRuntimeDiagnosticsSink(),
        onStorageReset: input?.onStorageReset ?? createPassThroughALStorageResetSink()
    };
}
