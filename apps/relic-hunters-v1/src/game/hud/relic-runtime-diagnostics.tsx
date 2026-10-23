import type {
    RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import { RelicCommandDeliveryRow } from '../relic-command-delivery-row.tsx';
import type { RelicRuntimeDiagnostics } from '../relic-hunters-runtime.ts';

interface RallarDiagnosticsPanelProps {
    readonly diagnostics: RelicRuntimeDiagnostics;
}

export function RallarDiagnosticsPanel({
    diagnostics
}: RallarDiagnosticsPanelProps) {
    return (
        <div className="panel stack rallar-diagnostics-panel" aria-label="Rallar diagnostics">
            <div>
                <span className="panel-label">Rallar</span>
                <strong>{diagnostics.phase}</strong>
            </div>
            <div className="diagnostic-grid">
                <DiagnosticFlag label="Auth" active={diagnostics.authenticated} />
                <DiagnosticFlag label="Connect" active={diagnostics.middlewareConnected} />
                <DiagnosticFlag label="Room" active={diagnostics.roomReady} />
                <DiagnosticFlag label="Snapshot" active={diagnostics.snapshotReady} />
                <DiagnosticFlag label="WS" active={diagnostics.wsListenerReady} />
                <DiagnosticFlag label="Rooms" active={diagnostics.roomListenerReady} />
                <DiagnosticFlag label="RTC" active={diagnostics.rtcReady} />
            </div>
            {diagnostics.roomId && <small>Room {diagnostics.roomId}</small>}
            <small>Commands {diagnostics.commandTransport.toUpperCase()}</small>
            <RelicCommandDeliveryRow delivery={diagnostics.lastCommandDelivery} />
            <small>Snapshots {diagnostics.snapshotTransport}</small>
            {diagnostics.lastSnapshotSource && <small>Last snapshot {diagnostics.lastSnapshotSource}</small>}
            {diagnostics.lastAcceptedSnapshot && (
                <small>
                    Accepted {diagnostics.lastAcceptedSnapshot.phase} r{diagnostics.lastAcceptedSnapshot.round} /{' '}
                    {diagnostics.lastAcceptedSnapshot.eventCount} events /{' '}
                    {diagnostics.lastAcceptedSnapshot.submittedCount} submitted
                </small>
            )}
            {diagnostics.ignoredSnapshotCount > 0 && (
                <small>Ignored stale snapshots {diagnostics.ignoredSnapshotCount}</small>
            )}
            {diagnostics.lastIgnoredSnapshotReason && (
                <small>Last ignored {diagnostics.lastIgnoredSnapshotReason}</small>
            )}
            {diagnostics.commandInFlight && <small>Command {diagnostics.commandInFlight}</small>}
            {diagnostics.lastError && <small className="diagnostic-error">{diagnostics.lastError}</small>}
        </div>
    );
}

interface DiagnosticFlagProps {
    readonly label: string;
    readonly active: boolean;
}

function DiagnosticFlag({
    label,
    active
}: DiagnosticFlagProps) {
    return (
        <span className={`diagnostic-flag${active ? ' active' : ''}`}>
            {label}
        </span>
    );
}

export function summarizeRelicHuntersRuntime(
    roomId: string | undefined,
    diagnostics: RelicRuntimeDiagnostics,
    snapshot: RelicPublicSnapshot | undefined
) {
    const activePlayerCount = snapshot?.players.filter(
        (player) => !player.escaped && !player.defeated
    ).length ?? 0;

    return {
        roomId,
        diagnostics,
        snapshot: snapshot
            ? {
                gameId: snapshot.gameId,
                roomId: snapshot.roomId,
                phase: snapshot.phase,
                round: snapshot.round,
                updatedAtEpochMs: snapshot.updatedAtEpochMs,
                playerIds: snapshot.players.map((player) => player.playerId),
                activePlayerCount,
                submittedPlayerIds: [...snapshot.submittedPlayerIds],
                eventIds: snapshot.events.map((event) => event.id),
                eventCount: snapshot.events.length
            }
            : undefined
    };
}
