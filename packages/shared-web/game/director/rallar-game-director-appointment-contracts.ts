import type { RallarDirectorStatus, RallarRoomState } from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarGameHostElectionResult } from './election.ts';

export type RallarGameDirectorAppointmentPolicy =
    | 'metadata-owner-admin-or-member-fallback'
    | 'metadata-owner-admin'
    | 'none'
    | 'custom';

export type RallarGameDirectorAppointmentEligibilityStatus =
    | 'allowed'
    | 'not-authorized'
    | 'not-ready'
    | 'no-local-peer';

export interface RallarGameDirectorAppointmentEligibility {
    readonly allowed: boolean;
    readonly status: RallarGameDirectorAppointmentEligibilityStatus;
    readonly policy: RallarGameDirectorAppointmentPolicy;
    readonly reason?: string;
    readonly localPeerId?: string;
    readonly localPrincipalId?: string;
    readonly localRole?: string;
    readonly localMemberStatus?: string;
}

export interface RallarGameDirectorAppointmentContext {
    readonly policy: RallarGameDirectorAppointmentPolicy;
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
    readonly roomState: RallarRoomState;
    readonly directorStatus: RallarDirectorStatus;
    readonly localPeerId?: string;
    readonly localPrincipalId?: string;
}

export interface RallarGameHostAppointResult {
    readonly status:
        | 'appointed'
        | 'not-elected'
        | 'not-authorized'
        | 'not-ready'
        | 'no-local-peer'
        | 'failed';
    readonly election: RallarGameHostElectionResult;
    readonly directorStatus?: RallarDirectorStatus;
    readonly reason?: string;
}

export interface RallarGameDirectorAppointmentDiagnostics extends RallarGameDirectorAppointmentEligibility {
    readonly lastResultStatus?: RallarGameHostAppointResult['status'];
    readonly lastReason?: string;
}
