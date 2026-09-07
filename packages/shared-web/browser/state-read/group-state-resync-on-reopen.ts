import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { emitBrowserStateReadDiagnostic } from './diagnostics.ts';

const RESYNC_CALLBACK_ID = 'rallar:group-state-resync-on-reopen';

export interface InitGroupStateResyncOnReopenInput {
    readonly socket: JsonWebSocketClient;
    readonly cancelSnapshotAssemblies: () => void;
    // Refresh authoritative snapshot collections into the caches and return the
    // accepted group snapshots (the connect-time hydration flow, re-run).
    readonly resyncStateSnapshots: () => Promise<readonly GroupSnapshot[]>;
    // Pull the current server overlays for the joined groups through the REST
    // read-through and adopt them under current-state precedence.
    readonly resyncGroupTopologies: (
        groupSnapshots: readonly GroupSnapshot[]
    ) => Promise<void>;
    // Middleware generation fence: false once this middleware is torn down, so a
    // stale socket reopen never hydrates a newer session's caches.
    readonly isCurrentGeneration: () => boolean;
}

// Registers a reopen resync: deltas and broadcasts missed while the socket was
// down are lost, not queued, so every socket reopen after the initial connect
// pulls state and overlays instead of waiting for the next broadcast. The
// registration happens after the initial connect completed, so every open this
// callback observes is a reconnect.
export function initGroupStateResyncOnReopen(
    input: InitGroupStateResyncOnReopenInput
): () => void {
    input.socket.onWebsocketCallbacksDo(RESYNC_CALLBACK_ID, {
        onOpen: () => {
            if (input.isCurrentGeneration()) {
                input.cancelSnapshotAssemblies();
            }
            void resyncAfterReopen(input);
        },
        onClose: () => {
            if (input.isCurrentGeneration()) {
                input.cancelSnapshotAssemblies();
            }
        }
    });
    return () => {
        if (input.isCurrentGeneration()) {
            input.cancelSnapshotAssemblies();
        }
        input.socket.removeWebsocketCallbackById(RESYNC_CALLBACK_ID);
    };
}

async function resyncAfterReopen(input: InitGroupStateResyncOnReopenInput): Promise<void> {
    const startedAtMs = Date.now();
    if (!input.isCurrentGeneration()) {
        emitReopenResyncDiagnostic('stale-generation', startedAtMs);
        return;
    }
    try {
        const groupSnapshots = await input.resyncStateSnapshots();
        if (!input.isCurrentGeneration()) {
            emitReopenResyncDiagnostic('stale-generation', startedAtMs);
            return;
        }
        await input.resyncGroupTopologies(groupSnapshots);
        emitReopenResyncDiagnostic('resynced', startedAtMs);
    }
    catch (error) {
        console.warn('Group-state resync after WS reopen failed', error);
        emitReopenResyncDiagnostic('error', startedAtMs);
    }
}

function emitReopenResyncDiagnostic(
    result: 'resynced' | 'stale-generation' | 'error',
    startedAtMs: number
): void {
    emitBrowserStateReadDiagnostic({
        name: 'rallar.browser.state-read',
        feature: 'group',
        operation: 'reopen-resync',
        result,
        durationMs: Date.now() - startedAtMs
    });
}
