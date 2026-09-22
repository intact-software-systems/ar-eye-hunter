import { useEffect, useRef, useState } from 'react';

import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';
import {
    toCapabilityDeliveryLabel,
    toDirectorAttemptLabel,
    toDirectorLabel,
    toHttpProbeLabel,
    toShortId,
    toShortOptional,
    toWsTicketBackoffLabel
} from './to-arena-labels.ts';

interface DiagnosticsDrawerProps {
    readonly nowMs: () => number;
    readonly arena: ArenaConnection;
    readonly onClose: () => void;
}
interface DiagnosticsSectionView {
    readonly title: string;
    readonly rows: readonly (readonly [label: string, value: string])[];
}
interface DiagnosticsJsonProps {
    readonly arena: ArenaConnection;
}

export function DiagnosticsDrawer({ arena, onClose, nowMs }: DiagnosticsDrawerProps) {
    const nowEpochMs = nowMs();
    useEffect(() => {
        if (!arena.networkEnabled) {
            return;
        }
        void arena.refreshDiagnostics({ includeRtcStats: true });
        const interval = window.setInterval(() => void arena.refreshDiagnostics({ includeRtcStats: true }), 4_000);
        return () => window.clearInterval(interval);
    }, [arena.refreshDiagnostics, arena.networkEnabled]);
    const sections = [
        toDirectorDiagnostics(arena, nowEpochMs),
        toMatchDiagnostics(arena),
        toTransportDiagnostics(arena, nowEpochMs),
        toHttpDiagnostics(arena),
        {
            title: 'Recent Events',
            rows: [
                ['Remote players', String(arena.remotePlayers.size)],
                ['Remote events', String(arena.remoteEvents.length)],
                ['Shots', String(arena.remoteShots.length)],
                ['Hits', String(arena.remotePlayerHits.length)]
            ]
        } satisfies DiagnosticsSectionView
    ];
    return (
        <aside className="diagnostics-drawer" aria-label="Arena diagnostics">
            <div className="diagnostics-header">
                <div>
                    <span>Diagnostics</span>
                    <strong>{arena.roomId ? toShortId(arena.roomId) : 'no room'}</strong>
                </div>
                <button type="button" onClick={onClose}>Close</button>
            </div>
            <DiagnosticsActions arena={arena} />
            {sections.map((section) => (
                <section key={section.title} className="diagnostics-section">
                    <h2>{section.title}</h2>
                    {section.rows.map(([label, value]) => (
                        <div key={label} className="diagnostics-row">
                            <span>{label}</span>
                            <strong>{value}</strong>
                        </div>
                    ))}
                    {section.title === 'RTC / Realtime' && (
                        <div className="lane-list">
                            {arena.rtcLanes.map((lane) => (
                                <span key={lane.laneId} data-state={lane.status}>
                                    {lane.laneId}: {lane.status}{' '}
                                    {lane.readyPeers}/{lane.readyPeers + lane.notReadyPeers}
                                </span>
                            ))}
                        </div>
                    )}
                </section>
            ))}
            <DiagnosticsJson arena={arena} />
        </aside>
    );
}

function DiagnosticsActions({ arena }: DiagnosticsJsonProps) {
    return (
        <div className="diagnostics-actions">
            <button
                type="button"
                disabled={!arena.networkEnabled || !arena.roomId || arena.directorAttempt.status === 'pending'}
                onClick={arena.appointSelfAsDirector}
            >
                Retry appoint
            </button>
            <button
                type="button"
                disabled={!arena.networkEnabled}
                onClick={() => arena.refreshDiagnostics({ includeRtcStats: true })}
            >
                Refresh
            </button>
            <button type="button" disabled={!arena.networkEnabled} onClick={arena.requestArenaSync}>
                Request sync
            </button>
        </div>
    );
}

function DiagnosticsJson({ arena }: DiagnosticsJsonProps) {
    const [copyStatus, setCopyStatus] = useState('Copy JSON');
    const pendingCopy = useRef<AbortController | undefined>(undefined);
    const resetTimer = useRef<number | undefined>(undefined);
    const diagnosticsJson = toDiagnosticsJson(arena);
    useEffect(() => () => {
        pendingCopy.current?.abort();
        window.clearTimeout(resetTimer.current);
    }, []);
    const copyDiagnostics = async () => {
        pendingCopy.current?.abort();
        window.clearTimeout(resetTimer.current);
        const controller = new AbortController();
        pendingCopy.current = controller;
        if (!navigator.clipboard) {
            setCopyStatus('Clipboard unavailable');
            return;
        }
        try {
            await navigator.clipboard.writeText(diagnosticsJson);
            if (!controller.signal.aborted) {
                setCopyStatus('Copied');
                resetTimer.current = window.setTimeout(() => setCopyStatus('Copy JSON'), 1_200);
            }
        }
        catch {
            if (!controller.signal.aborted) {
                setCopyStatus('Copy failed');
            }
        }
    };
    return (
        <details className="diagnostics-json">
            <summary>JSON</summary>
            <button type="button" onClick={copyDiagnostics}>{copyStatus}</button>
            <pre>{diagnosticsJson}</pre>
        </details>
    );
}

function toDiagnosticsJson(arena: ArenaConnection): string {
    return JSON.stringify(
        {
            directorAttempt: arena.directorAttempt,
            directorStatus: arena.directorStatus,
            match: arena.gameDiagnostics,
            transport: arena.transportDiagnostics,
            http: arena.httpDiagnostics,
            link: arena.linkState,
            lanes: arena.rtcLanes,
            lifecycle: {
                authStorageKind: arena.authStorageKind,
                authGeneration: arena.authGeneration,
                networkEnabled: arena.networkEnabled,
                logoutQuiesced: arena.logoutQuiesced,
                wsTicketBackoff: arena.transportDiagnostics.wsTicketBackoff
            },
            ai: { status: arena.aiStatus, error: arena.aiError }
        },
        null,
        2
    );
}

function toDirectorDiagnostics(arena: ArenaConnection, nowEpochMs: number): DiagnosticsSectionView {
    return {
        title: 'Director',
        rows: [
            ['Role', toDirectorLabel(arena.directorStatus)],
            ['Fresh', arena.directorStatus.isFresh ? 'yes' : 'no'],
            ['Attempt', toDirectorAttemptLabel(arena.directorAttempt)],
            ['Capability delivery', toCapabilityDeliveryLabel(arena.directorAttempt.capabilityDelivery)],
            [
                'Heartbeat',
                arena.directorStatus.lastHeartbeatAtEpochMs
                    ? `${nowEpochMs - arena.directorStatus.lastHeartbeatAtEpochMs} ms ago`
                    : 'none'
            ]
        ]
    };
}
function toMatchDiagnostics(arena: ArenaConnection): DiagnosticsSectionView {
    return {
        title: 'Match Election',
        rows: [
            ['Phase', arena.gameDiagnostics?.phase ?? 'unknown'],
            ['Authority', arena.gameDiagnostics?.directorAuthority ?? 'unknown'],
            ['Eligibility', arena.gameDiagnostics?.appointment?.status ?? 'unknown'],
            ['Local role', arena.gameDiagnostics?.appointment?.localRole ?? 'unknown'],
            ['Host', toShortOptional(arena.gameDiagnostics?.hostPeerId)],
            ['Director', toShortOptional(arena.gameDiagnostics?.directorPeerId)],
            ['Ready peers', String(arena.gameDiagnostics?.readyPeerIds.length ?? 0)],
            ['Issues', arena.gameDiagnostics?.issues.join(', ') || 'none']
        ]
    };
}
function toTransportDiagnostics(arena: ArenaConnection, nowEpochMs: number): DiagnosticsSectionView {
    return {
        title: 'RTC / Realtime',
        rows: [
            ['Squad Link', `${arena.linkState.label} (${arena.linkState.tone})`],
            ['Reliable', arena.gameDiagnostics?.egress.reliable ?? 'unknown'],
            ['RTC', arena.gameDiagnostics?.egress.realtime ?? 'unknown'],
            ['WS', arena.transportDiagnostics.ws?.readyState ?? 'unknown'],
            ['WS ticket', toWsTicketBackoffLabel(arena.transportDiagnostics.wsTicketBackoff, nowEpochMs)],
            [
                'RTC peers',
                `${arena.transportDiagnostics.rtc?.readyPeerIds.length ?? 0}/${
                    arena.transportDiagnostics.rtc?.knownPeerIds.length ?? 0
                }`
            ],
            ['Relay peers', String(arena.transportDiagnostics.rtcDiagnostics?.relayPeerCount ?? 0)],
            ['Realtime lanes', String(arena.transportDiagnostics.realtimeHealth.length)]
        ]
    };
}
function toHttpDiagnostics(arena: ArenaConnection): DiagnosticsSectionView {
    return {
        title: 'HTTP / API',
        rows: [
            ['Auth storage', arena.authStorageKind],
            ['Generation', String(arena.authGeneration)],
            ['Network', arena.networkEnabled ? 'enabled' : 'disabled'],
            ['Logout', arena.logoutQuiesced ? 'quiesced' : 'active'],
            ['Config', toHttpProbeLabel(arena.httpDiagnostics.apiConfig)],
            ['ICE', toHttpProbeLabel(arena.httpDiagnostics.ice)]
        ]
    };
}
