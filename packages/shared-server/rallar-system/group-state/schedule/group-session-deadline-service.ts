import { requireEpoch, requireString } from '@shared/api/exact-object-decoding.ts';
import { readGroupSessionSchedule } from '@shared/api/group-sessions/group-session-schedule.ts';
import type { Group, GroupMember } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { RallarServerAppInbox } from '../../../rallar-server/rallar-server-app-inbox.ts';
import {
    computeRuntimeStateObservations,
    type RuntimeStateObservations
} from '../../../runtime-state/observation/runtime-state-observation.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { readRuntimeStateObservationsCurrent } from '../../../runtime-state/postgres/read-runtime-state-observations-current.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import type { AppInboxMessageContext } from '../../app-inbox/app-inbox-contracts.ts';
import { validateComputedProjection, type ComputedDataValidationIssue } from '../../computed-data-validation.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import { computeViewInvalidationPublication } from '../../websocket/outbox/compute-view-invalidation-publication.ts';
import {
    computeGuardedViewPublication,
    writeGuardedViewPublication,
    type GuardedViewPublication
} from '../../websocket/outbox/guarded-view-publication.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import type { GroupStateRepository } from '../persistence/group-state-repository.ts';
import { GROUPS_NAMESPACE } from '../persistence/group-state-runtime-namespaces.ts';
import { groupStateMemberStorageKey } from '../persistence/membership/group-membership-storage-key.ts';
import { validateGroupStateRuntimeEntry } from '../persistence/validate-group-state-runtime-entry.ts';
import { validateStoredMember } from '../persistence/validate-persisted-group.ts';
import { validateStoredGroup } from '../persistence/validate-persisted-group.ts';
import { decodeGroupSessionDeadline, type GroupSessionDeadline } from './group-session-deadline.ts';
import { readGroupSessionViewAudience, type GroupSessionViewAudience } from './read-group-session-view-audience.ts';

export namespace GroupSessionDeadlineService {
    export interface Dependencies {
        readonly appInbox: RallarServerAppInbox;
        readonly groups: Pick<
            GroupStateRepository,
            'findGroupEntry' | 'findSessionReservationsEntry' | 'findMemberEntry'
        >;
        readonly runtime: RuntimeStateRepositoryLike;
        readonly nowEpochMs: () => number;
        readonly serviceId: string;
        readonly retentionMs: number;
    }

    export interface Read {
        readonly command: GroupSessionDeadline;
        readonly nowEpochMs: number;
        readonly traceId: string;
        readonly group: RuntimeStateEntryValue<Group> | null;
        readonly audience: GroupSessionViewAudience | null;
        readonly reservationPrincipals: readonly string[];
        readonly invitation: RuntimeStateEntryValue<GroupMember> | null;
    }

    /** The notice commits while the group row it was computed from still holds; that row is not rewritten. */
    export interface Computed {
        readonly observations: RuntimeStateObservations;
        readonly publication: GuardedViewPublication;
    }
}

/** Durable phase wakes only invalidate views: gameplay still requires its explicit authoritative command. */
export class GroupSessionDeadlineService {
    readonly wake: RallarServerAppInbox.Operation<GroupSessionDeadline, GroupSessionDeadline>;
    private readonly dependencies: GroupSessionDeadlineService.Dependencies;

    constructor(dependencies: GroupSessionDeadlineService.Dependencies) {
        this.dependencies = dependencies;
        this.wake = dependencies.appInbox.register({
            type: 'app:rallar-session:deadline',
            decodeEnvelope: ({ data }) => decodeGroupSessionDeadline(data),
            encodeEnvelope: (command) => ({ data: decodeJsonWireValue(command, 'Session deadline') }),
            toBinding: (command) => ({
                contextId: computeSha256CanonicalJson(command.ref),
                resourceId: computeSha256CanonicalJson(command)
            }),
            toLogicalCommand: (command) => decodeJsonWireValue(command, 'Logical session deadline'),
            materialize: (command) => command,
            encodeResult: (result) => decodeJsonWireValue(result, 'Session deadline result'),
            decodeResult: decodeGroupSessionDeadline,
            handle: (command, context) => this.wakeDeadline(command, context)
        });
    }

    async read(command: GroupSessionDeadline, traceId: string): Promise<GroupSessionDeadlineService.Read> {
        const nowEpochMs = this.dependencies.nowEpochMs();
        if (nowEpochMs < command.dueAtEpochMs) {
            throw new Error('Session deadline is not due');
        }
        // Registration and intents advance this predecessor, so its observation retries a concurrent audience insertion.
        const group = await this.dependencies.groups.findGroupEntry(command.ref) ?? null;
        const [audience, reservations, invitation] = group === null ? [null, undefined, null] : await Promise.all([
            readGroupSessionViewAudience(this.dependencies.runtime, command.ref, nowEpochMs),
            this.dependencies.groups.findSessionReservationsEntry(command.ref),
            command.kind === 'invitation-expire'
                ? this.dependencies.groups.findMemberEntry({ ...command.ref, principalId: command.principalId })
                : null
        ]);
        return {
            command,
            nowEpochMs,
            traceId,
            group,
            audience,
            invitation: invitation ?? null,
            reservationPrincipals: reservations?.value.principalIds ?? []
        };
    }

    compute(read: GroupSessionDeadlineService.Read): GroupSessionDeadlineService.Computed | null {
        assertDeadlineRead(read);
        const { group, command, audience } = read;
        if (group === null || group.value.status !== 'active') {
            return null;
        }
        const schedule = readGroupSessionSchedule(group.value.metadata);
        if (
            schedule === null || schedule.cancelledAtEpochMs !== null ||
            group.value.created.atEpochMs !== command.groupCreatedAtEpochMs
        ) {
            return null;
        }
        if (command.kind === 'invitation-expire') {
            const member = read.invitation?.value;
            if (
                member?.status !== 'invited' || member.invitationExpiresAtEpochMs !== command.dueAtEpochMs ||
                computeSha256CanonicalJson(member) !== command.memberFingerprint
            ) {
                return null;
            }
        }
        else if (
            schedule.revision !== command.scheduleRevision || schedule.startsAtEpochMs !== command.startsAtEpochMs
        ) {
            return null;
        }
        if (audience === null) {
            throw new TypeError('Session deadline requires its captured private audience');
        }
        const publication = computeViewInvalidationPublication({
            resource: 'sessions',
            scope: { applicationId: command.ref.applicationId, workspaceId: command.ref.workspaceId },
            principalIds: [
                group.value.ownerPrincipalId,
                ...audience.principalIds,
                ...read.reservationPrincipals,
                ...(command.kind === 'invitation-expire' ? [command.principalId] : [])
            ],
            changeId: computeSha256CanonicalJson(command),
            createdAtEpochMs: read.nowEpochMs,
            retentionMs: this.dependencies.retentionMs,
            serviceId: this.dependencies.serviceId,
            traceId: read.traceId
        });
        const [first, ...rest] = publication.provenance;
        if (first?.operation !== 'insert') {
            throw new TypeError('Session deadline notice requires its delivery provenance');
        }
        return {
            observations: computeRuntimeStateObservations([{
                namespace: GROUPS_NAMESPACE,
                key: group.entry.key,
                entry: group.entry
            }]),
            publication: computeGuardedViewPublication({
                guard: {
                    operation: 'insert',
                    namespace: first.namespace,
                    key: first.key,
                    value: first.value,
                    expireAtTimestamp: first.expireAtTimestamp
                },
                effects: rest
            }, publication.outbox)
        };
    }

    validate(
        read: GroupSessionDeadlineService.Read,
        computed: GroupSessionDeadlineService.Computed | null
    ): readonly ComputedDataValidationIssue[] {
        return validateComputedProjection(this.compute(read), computed, 'Session deadline');
    }

    private async wakeDeadline(
        command: GroupSessionDeadline,
        context: AppInboxMessageContext<GroupSessionDeadline>
    ): Promise<GroupSessionDeadline> {
        const read = await this.read(command, context.message.id.traceId);
        const computed = this.compute(read);
        const issue = this.validate(read, computed)[0];
        if (issue !== undefined) {
            throw issue.cause;
        }
        return await this.dependencies.appInbox.commit(
            context,
            command,
            (transaction) => writeGroupSessionDeadline(transaction, computed)
        );
    }
}

export async function writeGroupSessionDeadline(
    transaction: PSqlSql,
    computed: GroupSessionDeadlineService.Computed | null
): Promise<void> {
    if (computed === null) {
        return;
    }
    await writeGuardedViewPublication(transaction, computed.publication);
    if (!(await readRuntimeStateObservationsCurrent(transaction, computed.observations))) {
        throw new RuntimeStateWriteConflictError();
    }
}

function assertDeadlineRead(read: GroupSessionDeadlineService.Read): void {
    decodeGroupSessionDeadline(read.command);
    requireEpoch(read.nowEpochMs, 'Deadline attempt time');
    requireString(read.traceId, 'Deadline trace');
    if (read.nowEpochMs < read.command.dueAtEpochMs) {
        throw new TypeError('Session deadline read precedes its boundary');
    }
    if (read.group !== null) {
        validateGroupStateRuntimeEntry(read.group, 'Deadline group', groupStateGroupStorageKey(read.command.ref));
        validateStoredGroup(read.group.value, read.command.ref);
    }
    if (read.invitation !== null) {
        if (read.command.kind !== 'invitation-expire') {
            throw new TypeError('Phase deadline cannot carry invitation authority');
        }
        const ref = { ...read.command.ref, principalId: read.command.principalId };
        validateGroupStateRuntimeEntry(read.invitation, 'Deadline invitation', groupStateMemberStorageKey(ref));
        validateStoredMember(read.invitation.value, ref, 'Deadline invitation');
        if (read.invitation.value.principalId !== read.command.principalId) {
            throw new TypeError('Deadline invitation belongs to another account');
        }
    }
    if (read.audience !== null && !jsonEquals(read.audience.ref, read.command.ref)) {
        throw new TypeError('Session deadline audience belongs to another group');
    }
    for (const principals of [read.audience?.principalIds ?? [], read.reservationPrincipals]) {
        for (const principalId of principals) {
            requireString(principalId, 'Deadline audience account');
        }
        if (new Set(principals).size !== principals.length) {
            throw new TypeError('Session deadline audience repeats an account');
        }
    }
}
