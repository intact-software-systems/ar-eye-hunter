import type { RallarDirectorStatus } from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    RallarGameDirectorAppointmentContext,
    RallarGameDirectorAppointmentEligibility,
    RallarGameHostAppointResult,
    RallarGameHostElectionResult,
    RallarGameMatchConfig
} from './types.ts';

export namespace RallarGameDirectorAppointmentRuntime {
    export interface RoomTarget {
        readonly roomId?: string;
        readonly roomRef?: GroupRef;
    }

    export interface Input<TInput, TIntent, TSnapshot, TEvent, TPresence> {
        readonly config: RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent, TPresence>;
        readonly heartbeatTtlMs: number;
        election(): RallarGameHostElectionResult;
        readRoomTarget(): RoomTarget;
        readDirectorStatus(): RallarDirectorStatus;
        refreshStatus(directorStatus?: RallarDirectorStatus): void;
    }
}

/** Owns browser-director appointment authorization and the appointment mutation. */
export class RallarGameDirectorAppointmentRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence> {
    private readonly input: RallarGameDirectorAppointmentRuntime.Input<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private appointmentResult: RallarGameHostAppointResult | undefined;

    constructor(
        input: RallarGameDirectorAppointmentRuntime.Input<TInput, TIntent, TSnapshot, TEvent, TPresence>
    ) {
        this.input = input;
    }

    get lastResult(): RallarGameHostAppointResult | undefined {
        return this.appointmentResult;
    }

    eligibility(): RallarGameDirectorAppointmentEligibility {
        const { config } = this.input;
        const room = this.input.readRoomTarget();
        const roomState = config.rallar.rooms.state();
        const session = config.rallar.session();
        const localPeerId = session?.sessionId;
        const localPrincipalId = session?.clientId;
        const directorStatus = this.input.readDirectorStatus();
        const policy = config.directorAppointmentPolicy ??
            'metadata-owner-admin-or-member-fallback';
        const context = {
            policy,
            roomId: room.roomId,
            roomRef: room.roomRef,
            roomState,
            directorStatus,
            localPeerId,
            localPrincipalId
        };

        if (config.canAppointDirector) {
            return config.canAppointDirector(context);
        }
        if (policy === 'none') {
            return {
                allowed: true,
                status: 'allowed',
                policy,
                localPeerId,
                localPrincipalId
            };
        }

        return resolveMetadataOwnerAdminAppointmentEligibility(context);
    }

    async appointIfElected(): Promise<RallarGameHostAppointResult> {
        const appointment = this.eligibility();
        const election = this.input.election();
        const localPeerId = this.input.config.rallar.session()?.sessionId;
        if (!localPeerId) {
            return this.record({
                status: 'no-local-peer',
                election,
                reason: 'Cannot appoint a director without a local session.'
            });
        }

        if (!appointment.allowed) {
            const result = this.record({
                status: appointment.status === 'not-ready'
                    ? 'not-ready'
                    : appointment.status === 'no-local-peer'
                    ? 'no-local-peer'
                    : 'not-authorized',
                election,
                reason: appointment.reason
            });
            this.input.refreshStatus();
            return result;
        }

        if (election.host?.peerId !== localPeerId) {
            return this.record({
                status: 'not-elected',
                election,
                reason: 'The local peer is not the elected host.'
            });
        }

        try {
            const room = this.input.readRoomTarget();
            const directorStatus = await this.input.config.rallar.director.appoint(
                room.roomRef ?? room.roomId,
                { heartbeatTtlMs: this.input.heartbeatTtlMs }
            );
            this.input.refreshStatus(directorStatus);
            return this.record({
                status: 'appointed',
                election,
                directorStatus
            });
        }
        catch (error) {
            return this.record({
                status: 'failed',
                election,
                reason: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private record(result: RallarGameHostAppointResult): RallarGameHostAppointResult {
        this.appointmentResult = result;
        return result;
    }
}

interface RallarGameAppointmentDeniedInput {
    readonly context: RallarGameDirectorAppointmentContext;
    readonly status: 'no-local-peer' | 'not-ready' | 'not-authorized';
    readonly reason: string;
    readonly member?: RallarGameAppointmentMember;
}

interface RallarGameAppointmentMember {
    readonly role: string;
    readonly status: string;
}

interface RallarGameMemberAppointmentInput {
    readonly context: RallarGameDirectorAppointmentContext;
    readonly member: RallarGameAppointmentMember;
    readonly localPeerId: string;
    readonly localPrincipalId: string;
}

function resolveMetadataOwnerAdminAppointmentEligibility(
    context: RallarGameDirectorAppointmentContext
): RallarGameDirectorAppointmentEligibility {
    if (!context.localPeerId || !context.localPrincipalId) {
        return appointmentDenied({
            context,
            status: 'no-local-peer',
            reason: 'Cannot appoint a director without a local session.'
        });
    }

    const member = context.roomState.members.find(
        (entry) => entry.principalId === context.localPrincipalId
    ) ?? context.roomState.currentRoom?.members.find(
        (entry) => entry.principalId === context.localPrincipalId
    );
    if (!member) {
        return appointmentDenied({
            context,
            status: 'not-ready',
            reason: 'Cannot confirm local room membership yet.'
        });
    }

    return resolveMemberAppointmentEligibility({
        context,
        member,
        localPeerId: context.localPeerId,
        localPrincipalId: context.localPrincipalId
    });
}

function resolveMemberAppointmentEligibility(
    input: RallarGameMemberAppointmentInput
): RallarGameDirectorAppointmentEligibility {
    const { context, member } = input;
    const localSessionActive = hasActiveLocalRoomSession(
        context.roomState,
        input.localPrincipalId,
        input.localPeerId
    );
    if (member.status !== 'active' || !localSessionActive) {
        return appointmentDenied({
            context,
            status: 'not-authorized',
            reason: 'Only active room members can appoint the browser director.',
            member
        });
    }

    if (member.role === 'owner' || member.role === 'admin') {
        return appointmentAllowed(context, member);
    }
    if (context.policy !== 'metadata-owner-admin-or-member-fallback') {
        return appointmentDenied({
            context,
            status: 'not-authorized',
            reason: 'Only active room owners/admins can appoint the browser director.',
            member
        });
    }
    if (hasOnlineOwnerOrAdmin(context.roomState)) {
        return appointmentDenied({
            context,
            status: 'not-authorized',
            reason: 'Only owners/admins can appoint while an owner/admin is online.',
            member
        });
    }
    if (context.directorStatus.active) {
        return appointmentDenied({
            context,
            status: 'not-authorized',
            reason: 'Cannot appoint a fallback director while another director is active.',
            member
        });
    }

    return appointmentAllowed(context, member);
}

function appointmentAllowed(
    context: RallarGameDirectorAppointmentContext,
    member: RallarGameAppointmentMember
): RallarGameDirectorAppointmentEligibility {
    return {
        allowed: true,
        status: 'allowed',
        policy: context.policy,
        localPeerId: context.localPeerId,
        localPrincipalId: context.localPrincipalId,
        localRole: member.role,
        localMemberStatus: member.status
    };
}

function appointmentDenied(input: RallarGameAppointmentDeniedInput): RallarGameDirectorAppointmentEligibility {
    return {
        allowed: false,
        status: input.status,
        policy: input.context.policy,
        reason: input.reason,
        localPeerId: input.context.localPeerId,
        localPrincipalId: input.context.localPrincipalId,
        localRole: input.member?.role,
        localMemberStatus: input.member?.status
    };
}

function hasActiveLocalRoomSession(
    roomState: RallarGameDirectorAppointmentContext['roomState'],
    principalId: string,
    sessionId: string
): boolean {
    return roomState.members.some((member) =>
        member.principalId === principalId &&
        (member.sessionIds ?? []).includes(sessionId)
    ) ||
        (roomState.currentRoom?.activeSessions ?? []).some((session) =>
            session.principalId === principalId && session.sessionId === sessionId
        );
}

function hasOnlineOwnerOrAdmin(
    roomState: RallarGameDirectorAppointmentContext['roomState']
): boolean {
    const ownerAdminIds = new Set(
        [...roomState.members, ...(roomState.currentRoom?.members ?? [])]
            .filter((member) =>
                member.status === 'active' &&
                (member.role === 'owner' || member.role === 'admin')
            )
            .map((member) => member.principalId)
    );

    return roomState.members.some((member) =>
        ownerAdminIds.has(member.principalId) &&
        (member.isOnline === true || (member.sessionIds?.length ?? 0) > 0)
    ) ||
        (roomState.currentRoom?.activeSessions ?? []).some(
            (session) => ownerAdminIds.has(session.principalId)
        );
}
