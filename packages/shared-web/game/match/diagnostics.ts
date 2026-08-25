import type {
    RallarRealtimeLaneHealth,
    RallarRtcDiagnostics,
    RallarRtcStatus,
    RallarWsStatus
} from '@shared-web/browser/rallar.ts';
import type { RallarGameHostCapability, RallarGameHostElectionResult } from '../director/election.ts';
import type {
    RallarGameDirectorAppointmentDiagnostics,
    RallarGameDirectorAppointmentEligibility,
    RallarGameHostAppointResult
} from '../director/rallar-game-director-appointment-contracts.ts';
import type { RallarGamePeerReadiness } from './rallar-game-match-egress-contracts.ts';
import type {
    RallarGameDirectorAuthority,
    RallarGameEgressStatus,
    RallarGameMatchPhase,
    RallarGameMatchStatus,
    RallarGameRecoveryState
} from './rallar-game-match-status.ts';

export interface RallarGameDiagnosticsInput {
    readonly status: RallarGameMatchStatus;
    readonly election?: RallarGameHostElectionResult;
    readonly appointment?: RallarGameDirectorAppointmentEligibility;
    readonly lastAppointment?: RallarGameHostAppointResult;
    readonly peerReadiness?: RallarGamePeerReadiness;
    readonly rtcStatus?: RallarRtcStatus;
    readonly rtcDiagnostics?: RallarRtcDiagnostics;
    readonly wsStatus?: RallarWsStatus;
    readonly realtimeHealth?: readonly RallarRealtimeLaneHealth[];
    readonly capabilities?: readonly RallarGameHostCapability[];
    readonly nowEpochMs?: number;
}

export interface RallarGameDiagnostics {
    readonly generatedAtEpochMs: number;
    readonly phase: RallarGameMatchPhase;
    readonly roomId?: string;
    readonly localPeerId?: string;
    readonly directorPeerId?: string;
    readonly directorEpoch?: number;
    readonly directorIsFresh: boolean;
    readonly directorAuthority: RallarGameDirectorAuthority;
    readonly egress: RallarGameEgressStatus;
    readonly recovery: RallarGameRecoveryState;
    readonly hostPeerId?: string;
    readonly backupPeerId?: string;
    readonly knownPeerIds: readonly string[];
    readonly readyPeerIds: readonly string[];
    readonly notReadyPeerIds: readonly string[];
    readonly capabilityCount: number;
    readonly rtcPeerCount: number;
    readonly rtcRelayPeerCount?: number;
    readonly wsStatus?: RallarWsStatus;
    readonly realtimeHealth: readonly RallarRealtimeLaneHealth[];
    readonly appointment?: RallarGameDirectorAppointmentDiagnostics;
    readonly issues: readonly string[];
}

export function deriveRallarGameDiagnostics(
    input: RallarGameDiagnosticsInput
): RallarGameDiagnostics {
    const generatedAtEpochMs = input.nowEpochMs ?? Date.now();
    const egress = input.status.egress ?? {
        reliable: 'empty' as const,
        realtime: 'empty' as const
    };
    const directorAuthority = input.status.directorAuthority ?? 'none';
    const readyPeerIds = uniqueSorted([
        ...(input.peerReadiness?.readyPeerIds ?? []),
        ...(input.rtcStatus?.readyPeerIds ?? [])
    ]);
    const notReadyPeerIds = uniqueSorted(input.peerReadiness?.notReadyPeerIds ?? []);
    const knownPeerIds = uniqueSorted([
        ...(input.rtcStatus?.knownPeerIds ?? []),
        ...readyPeerIds,
        ...notReadyPeerIds
    ]);
    const issues = deriveIssues(input);

    return {
        generatedAtEpochMs,
        phase: input.status.phase,
        roomId: input.status.roomId,
        localPeerId: input.status.localPeerId,
        directorPeerId: input.status.directorPeerId,
        directorEpoch: input.status.directorEpoch,
        directorIsFresh: input.status.directorIsFresh,
        directorAuthority,
        egress,
        recovery: input.status.recovery,
        hostPeerId: input.election?.host?.peerId,
        backupPeerId: input.election?.backup?.peerId,
        knownPeerIds,
        readyPeerIds,
        notReadyPeerIds,
        capabilityCount: input.capabilities?.length ?? 0,
        rtcPeerCount: input.rtcDiagnostics?.peerCount ??
            input.rtcStatus?.knownPeerIds.length ??
            0,
        rtcRelayPeerCount: input.rtcDiagnostics?.relayPeerCount,
        wsStatus: input.wsStatus,
        realtimeHealth: input.realtimeHealth ?? [],
        appointment: input.appointment
            ? {
                ...input.appointment,
                lastResultStatus: input.lastAppointment?.status,
                lastReason: input.lastAppointment?.reason
            }
            : undefined,
        issues
    };
}

function deriveIssues(input: RallarGameDiagnosticsInput): readonly string[] {
    const issues: string[] = [];

    if (!input.status.roomId) {
        issues.push('no-room');
    }

    if (!input.status.localPeerId) {
        issues.push('no-local-peer');
    }

    if (!input.status.directorPeerId) {
        issues.push('no-director');
    }
    else if (!input.status.directorIsFresh) {
        issues.push('stale-director');
    }

    if (input.status.recovery.status === 'recovering') {
        issues.push('recovering');
    }

    if (input.wsStatus && !input.wsStatus.isOpen) {
        issues.push('ws-not-open');
    }

    if (input.peerReadiness?.status === 'partial') {
        issues.push('partial-lane-readiness');
    }

    const egress = input.status.egress ?? {
        reliable: 'empty' as const,
        realtime: 'empty' as const
    };

    if (egress.realtime === 'warming') {
        issues.push('rtc-warming');
    }
    else if (egress.realtime === 'timeout') {
        issues.push('rtc-timeout');
    }
    else if (egress.realtime === 'failed') {
        issues.push('rtc-failed');
    }

    if (
        input.peerReadiness &&
        !['open', 'partial', 'empty'].includes(input.peerReadiness.status)
    ) {
        issues.push(`lane-${input.peerReadiness.status}`);
    }

    if (input.election && !input.election.host) {
        issues.push('no-electable-host');
    }

    if (input.appointment?.status === 'not-authorized') {
        issues.push('director-not-authorized');
    }

    if (input.appointment?.status === 'not-ready') {
        issues.push('director-eligibility-not-ready');
    }

    return uniqueSorted(issues);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
