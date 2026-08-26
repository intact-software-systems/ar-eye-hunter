import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';

export interface RallarServerWsConnectionStatus {
    readonly connectionId: string;
    readonly isOpen: boolean;
}

export interface RallarServerWsStatus {
    readonly transport: 'ws-server';
    readonly connectionCount: number;
    readonly openConnectionCount: number;
    readonly connectionIds: readonly string[];
    readonly openConnectionIds: readonly string[];
    readonly connections: readonly RallarServerWsConnectionStatus[];
}

export function readRallarServerWsStatus(
    service: WsQueueBoxServerService
): RallarServerWsStatus {
    const socketConnections = service.socket.connections;
    const connections: readonly RallarServerWsConnectionStatus[] = socketConnections instanceof Map
        ? [...socketConnections.values()].map((context) => ({
            connectionId: context.id,
            isOpen: context.isOpen
        }))
        : [];
    const openConnectionIds = connections
        .filter((connection) => connection.isOpen)
        .map((connection) => connection.connectionId);

    return {
        transport: 'ws-server',
        connectionCount: connections.length,
        openConnectionCount: openConnectionIds.length,
        connectionIds: connections.map((connection) => connection.connectionId),
        openConnectionIds,
        connections
    };
}
