import {
    readGroupSessionSchedule,
    toGroupSessionTiming,
    type GroupSessionPage,
    type GroupSessionPreview
} from '@shared/api/group-sessions/group-session-schedule.ts';
import { isGroupSpectator } from '@shared/api/group-spectating.ts';
import type { GroupRef, GroupScope } from '@shared/api/group-types.ts';

import type { GroupStateRepository } from '../persistence/group-state-repository.ts';
import type { GroupStateMutationExactEntries } from '../persistence/read-exact-group-state-mutation.ts';
import { canUseGroupAdmissionCredentials } from '../policy/group-membership-admission-policy.ts';
import { countGroupSessionOccupiedSeats } from './group-session-reservations.ts';

export namespace GroupSessionDirectory {
    export interface Dependencies {
        readonly repository: Pick<GroupStateRepository, 'readMutationExactEntries' | 'listSessionIntentsPage'>;
        readonly now: () => number;
    }
}

/** Current, account-specific read projections; reservation identities never leave this boundary. */
export class GroupSessionDirectory {
    private readonly dependencies: GroupSessionDirectory.Dependencies;

    public constructor(dependencies: GroupSessionDirectory.Dependencies) {
        this.dependencies = dependencies;
    }

    public async read(ref: GroupRef, principalId: string): Promise<GroupSessionPreview | null> {
        const entries = await this.dependencies.repository.readMutationExactEntries({
            aggregateRef: ref,
            includeGroup: true,
            includeGroupSnapshot: true,
            includeSessionReservations: true,
            sessionIntentPrincipalId: principalId,
            includePresenceSummary: true,
            includeLifecyclePolicy: false,
            authSessionId: null,
            requestIds: [],
            memberPrincipalIds: [],
            presenceSessionIds: [],
            admissionPrincipalIds: [],
            publicationGrantPrincipalIds: []
        });
        return toGroupSessionPreview({ ref, principalId, entries, nowEpochMs: this.dependencies.now() });
    }

    public async listForPrincipal(
        scope: GroupScope,
        principalId: string,
        afterKey: string | null
    ): Promise<GroupSessionPage> {
        const page = await this.dependencies.repository.listSessionIntentsPage(scope, principalId, afterKey);
        const sessions: GroupSessionPreview[] = [];
        for (const intent of page.intents) {
            const preview = await this.read({ ...scope, groupId: intent.groupId }, principalId);
            if (preview !== null) {
                sessions.push(preview);
            }
        }
        return { sessions, nextKey: page.nextKey };
    }
}

interface GroupSessionPreviewRead {
    readonly ref: GroupRef;
    readonly principalId: string;
    readonly entries: GroupStateMutationExactEntries;
    readonly nowEpochMs: number;
}

function toGroupSessionPreview(
    { ref, principalId, entries, nowEpochMs }: GroupSessionPreviewRead
): GroupSessionPreview | null {
    const snapshot = entries.groupSnapshot.status === 'read' ? entries.groupSnapshot.snapshot : undefined;
    if (snapshot === undefined || snapshot.group.status !== 'active') {
        return null;
    }
    const schedule = readGroupSessionSchedule(snapshot.group.metadata);
    if (schedule === null) {
        return null;
    }
    const reservations = entries.sessionReservations?.value;
    if (reservations === undefined || snapshot.group.maxMembers === null) {
        throw new TypeError('Scheduled room preview requires complete capacity and reservation state');
    }
    const timing = toGroupSessionTiming(schedule, nowEpochMs);
    const activePlayers = snapshot.members.filter((member) => member.status === 'active' && !isGroupSpectator(member))
        .map((member) => member.principalId);
    const occupied = countGroupSessionOccupiedSeats({
        schedule,
        reservations,
        activePlayerPrincipalIds: activePlayers,
        nowEpochMs
    });
    const reserved = reservations.principalIds.includes(principalId);
    const admitted = activePlayers.includes(principalId);
    const expired = timing.phase === 'reservations-expired' || timing.phase === 'cancelled';
    const availability = canUseGroupAdmissionCredentials({ snapshot, actor: { principalId }, nowEpochMs });
    return {
        roomRef: ref,
        displayName: snapshot.group.displayName,
        schedule,
        timing,
        serverNowEpochMs: nowEpochMs,
        maxPlayers: snapshot.group.maxMembers,
        availableSeats: Math.max(0, snapshot.group.maxMembers - occupied),
        participation: admitted ? 'admitted' : reserved && !expired
            ? 'reserved'
            : entries.sessionIntent !== null &&
                    entries.sessionIntent.value.reviewedScheduleRevision < schedule.revision &&
                    timing.phase !== 'cancelled'
            ? 'needs-confirmation'
            : 'none',
        isOrganizer: snapshot.group.ownerPrincipalId === principalId,
        admissionDenial: !availability.allowed
            ? availability.code
            : !admitted && !(!expired && reserved) && occupied >= snapshot.group.maxMembers
            ? 'group-full'
            : null,
        canReserve: !expired && availability.allowed &&
            (admitted || reserved || occupied < snapshot.group.maxMembers),
        canEnter: timing.phase !== 'upcoming' && timing.phase !== 'cancelled' && availability.allowed &&
            (admitted || (!expired && reserved) || occupied < snapshot.group.maxMembers)
    };
}
