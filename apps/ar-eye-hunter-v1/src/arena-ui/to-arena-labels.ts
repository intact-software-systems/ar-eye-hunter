import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';
import type { ArenaMatchState } from '../game/types.ts';

export function toDirectorLabel(
    status: ArenaConnection['directorStatus']
): string {
    if (status.state === 'none') {
        return 'peer mode';
    }
    if (status.isDirector) {
        return status.state === 'fresh' ? 'you' : `you ${status.state}`;
    }
    return status.state;
}

export function toMatchLabel(
    match: ArenaMatchState | undefined,
    remainingMs: number
): string {
    if (!match) {
        return 'infinite';
    }
    if (match.status === 'active') {
        return toDurationLabel(remainingMs);
    }
    const winner = match.results?.[0];
    return winner ? `${winner.username} won` : 'complete';
}

export function toDurationLabel(ms: number): string {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function toShortId(id: string): string {
    return id.length <= 8 ? id : id.slice(0, 8);
}

export function toDirectorAttemptLabel(attempt: ArenaConnection['directorAttempt']): string {
    if (attempt.status === 'idle') {
        return 'idle';
    }
    if (attempt.status === 'pending') {
        return `${attempt.source} pending`;
    }
    const detail = attempt.reason ? `: ${attempt.reason}` : '';
    return `${attempt.source} ${attempt.status}${detail}`;
}

export function toHttpProbeLabel(probe: ArenaConnection['httpDiagnostics']['apiConfig']): string {
    if (probe.status === 'idle') {
        return 'idle';
    }
    const timing = probe.durationMs === undefined ? '' : ` ${probe.durationMs}ms`;
    const detail = probe.detail || probe.reason;
    return `${probe.status}${timing}${detail ? ` ${detail}` : ''}`;
}

export function toWsTicketBackoffLabel(
    state: ArenaConnection['transportDiagnostics']['wsTicketBackoff'],
    nowEpochMs: number
): string {
    if (!state || state.status === 'idle') {
        return 'idle';
    }
    if (state.status === 'local-rate-limited') {
        return 'local throttle';
    }
    if (state.status === 'circuit-open') {
        return 'circuit open';
    }
    return `cooldown ${Math.max(0, state.retryAtEpochMs - nowEpochMs)}ms`;
}

export function toShortOptional(value: string | undefined): string {
    return value ? toShortId(value) : 'none';
}

export function toCapabilityDeliveryLabel(delivery: ArenaConnection['directorAttempt']['capabilityDelivery']): string {
    if (!delivery) {
        return 'no WS observation';
    }
    if (delivery.state === 'unobservable') {
        return 'observation lost';
    }
    if (delivery.state === 'confirmed') {
        return delivery.evidence === 'acknowledged' ? 'acknowledged (hop)' : 'transport accepted (hop)';
    }
    if (delivery.state === 'pending') {
        return `pending (${delivery.evidence})`;
    }
    return `${delivery.state}${delivery.reason ? `: ${delivery.reason}` : ''}`;
}

export function toArenaDiagnosticsAttributes(
    arena: ArenaConnection,
    diagnosticsOpen: boolean
): Readonly<Record<string, string>> {
    return {
        'data-arena-director-attempt': arena.directorAttempt.status,
        'data-arena-diagnostics-open': diagnosticsOpen ? 'true' : 'false',
        'data-arena-ws-state': arena.transportDiagnostics.ws?.readyState ?? 'unknown',
        'data-arena-rtc-ready-peers': String(
            arena.transportDiagnostics.rtc?.readyPeerIds.length ??
                arena.rtcLanes.reduce((sum, lane) => sum + lane.readyPeers, 0)
        ),
        'data-arena-http-status': `${arena.httpDiagnostics.apiConfig.status}/${arena.httpDiagnostics.ice.status}`,
        'data-arena-network-enabled': arena.networkEnabled ? 'true' : 'false'
    };
}
