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
}

export interface RallarDiagnosticsPorts {
    readonly transportFaultPort: TransportFaultPort;
    readonly indexedDbOperationObserver: IndexedDbOperationObserver;
}

export function toRallarDiagnosticsPorts(
    input: RallarDiagnosticsPortsInput | undefined
): RallarDiagnosticsPorts {
    return {
        transportFaultPort: input?.transportFaultPort ?? createPassThroughTransportFaultPort(),
        indexedDbOperationObserver: input?.indexedDbOperationObserver ??
            createPassThroughIndexedDbOperationObserver()
    };
}
