import { EventAlertWorker } from './event-alert-worker.ts';
import { validateEventAlertConsent, type EventWebPush } from './event-web-push.ts';
import { requireExactKeys, requirePositiveInteger, requireRecord } from '@shared/api/exact-object-decoding.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { projectRoomEventOrganizerView } from '@shared/api/room-events/room-event-organizer-view.ts';
import { GroupMutationAuthorizationError } from '../group-state/group-mutation-authority.ts';
import { decodeRoomEvent } from '@shared/api/room-events/decode-room-event.ts';
import { changeRoomEvent, createRoomEvent, projectRoomEvent, type RoomEvent } from '@shared/api/room-events/room-event.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { RallarServerAppInbox } from '../../rallar-server/rallar-server-app-inbox.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/runtime-state-json-store.ts';
import type { RuntimeStateRepositoryLike } from '../../runtime-state/runtime-state-repository.ts';
import type { AppInboxMessageContext } from '../app-inbox/app-inbox-contracts.ts';
import { writeAppOutboxInserts } from '../app-outbox/app-outbox-insert.ts';
import { computeArchivePresenceFences } from '../group-state/retention/compute-group-retention-write.ts';
import { groupStateUpdateGroupDescriptor } from '../group-state/persistence/aggregate/group-aggregate-write-descriptors.ts';
import { readRoomEventLifetime } from './read-room-event-lifetime.ts';
import { AppOutboxType } from '../app-outbox/app-outbox-type.ts';
import { installDurableDeadline, type DurableDeadlineDelivery } from '../app-outbox/install-durable-deadline.ts';
import type { GroupMutationComputedWrite } from '../group-state/mutation/group-mutation-contracts.ts';
import { computeSha256CanonicalJson } from '../protocol/compute-sha256-canonical-json.ts';
import { decodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import { writeGuardedViewPublication } from '../websocket/outbox/guarded-view-publication.ts';
import type { EventRoomAccessEffects } from './event-room-access-effects.ts';
import { RoomEventAuthority } from './room-event-authority.ts';
import { decodeRoomEventMutation, type RoomEventActor, type RoomEventMutation } from './room-event-command.ts';
import { decodeRoomEventDeadline, roomEventDeadlineRoute, roomEventSignal, ROOM_EVENT_DEADLINE_TOPIC, type RoomEventDeadline } from './room-event-deadline.ts';
import { RoomEventRepository } from './room-event-repository.ts';

export namespace TemporaryEventService {
    export interface Dependencies extends RoomEventAuthority.Dependencies {
        readonly appInbox: RallarServerAppInbox;
        readonly webPush?: EventWebPush;
        readonly runtime: Pick<RuntimeStateRepositoryLike, 'findEntry'>;
        readonly roomAccess: Pick<EventRoomAccessEffects, 'prepare' | 'write'>;
        readonly nowEpochMs: () => number;
    }
    export interface Config {
        readonly serviceId: string;
        readonly finishedRetentionMs: number;
        readonly organizerIds: readonly string[];
        readonly handoverWindowMs: number;
        readonly organizerIdsByApplication?: Readonly<Record<string, readonly string[]>>;
    }
    export interface Result { readonly revision: number; }
}

interface EventTransition {
    readonly before: RuntimeStateEntryValue<RoomEvent> | null;
    readonly after: RoomEvent;
    readonly actor: RoomEventActor | null;
    readonly command: RoomEvent.Command;
    readonly authority: RoomEventAuthority.Verified;
    readonly requestId: string;
    readonly traceId: string;
    readonly nowEpochMs: number;
    readonly courtTransport?: RoomEventMutation['courtTransport'];
}

/** One event guard serializes party consent and court allocation. Room membership changes and wakes share its commit. */
export class TemporaryEventService {
    readonly pushPublicKey: string | null;
    private readonly alertWorker: EventAlertWorker | undefined;
    readonly mutate: RallarServerAppInbox.Operation<RoomEventMutation, TemporaryEventService.Result>;
    private readonly expire: RallarServerAppInbox.Operation<RoomEventDeadline, RoomEventDeadline>;
    private readonly dependencies: TemporaryEventService.Dependencies;
    private readonly config: TemporaryEventService.Config;
    private readonly repository: RoomEventRepository;
    private readonly authority: RoomEventAuthority;

    constructor(dependencies: TemporaryEventService.Dependencies, config: TemporaryEventService.Config) {
        this.dependencies = dependencies;
        this.config = config;
        this.repository = new RoomEventRepository(dependencies.runtime);
        this.pushPublicKey = dependencies.webPush?.publicKey ?? null;
        if (dependencies.webPush) this.alertWorker = new EventAlertWorker({ ...dependencies, ...config,
            repository: this.repository, provider: dependencies.webPush });
        this.authority = new RoomEventAuthority(dependencies, config.organizerIds, config.organizerIdsByApplication);
        this.mutate = dependencies.appInbox.register({
            type: 'app:rallar-events:mutate',
            decodeEnvelope: ({ data }) => decodeRoomEventMutation(data),
            encodeEnvelope: command => ({ data: decodeJsonWireValue(command, 'Room event operation') }),
            toBinding: command => ({ contextId: computeSha256CanonicalJson({ lobby: command.lobby, principalId: command.principalId }), resourceId: command.requestId }),
            toLogicalCommand: command => decodeJsonWireValue(command, 'Room event operation'),
            materialize: command => command,
            encodeResult: result => ({ revision: result.revision }),
            decodeResult: decodeEventResult,
            handle: (command, context) => this.execute(command, context)
        });
        this.expire = dependencies.appInbox.register({
            type: 'app:rallar-events:deadline',
            decodeEnvelope: ({ data }) => decodeRoomEventDeadline(data),
            encodeEnvelope: command => ({ data: decodeJsonWireValue(command, 'Room event deadline') }),
            toBinding: command => ({ contextId: computeSha256CanonicalJson(command.lobby), resourceId: roomEventDeadlineRoute(command).resourceId }),
            toLogicalCommand: command => decodeJsonWireValue(command, 'Room event deadline'),
            materialize: command => command,
            encodeResult: result => decodeJsonWireValue(result, 'Room event deadline'),
            decodeResult: (value, command) => {
                const result = decodeRoomEventDeadline(value);
                if (!jsonEquals(result, command)) throw new TypeError('Room event deadline result differs from its command.');
                return result;
            },
            handle: (deadline, context) => this.settle(deadline, context)
        });
    }

    listen(input: Pick<DurableDeadlineDelivery<RoomEventDeadline>, 'database' | 'outboxQueueReader'>): void {
        this.alertWorker?.listen(input);
        installDurableDeadline({ ...input, typeId: AppOutboxType.ROOM_EVENT_DEADLINE, topicId: ROOM_EVENT_DEADLINE_TOPIC,
            retentionMs: this.config.finishedRetentionMs, nowEpochMs: this.dependencies.nowEpochMs,
            route: roomEventDeadlineRoute, decode: decodeRoomEventDeadline, enqueue: async (command, traceId) => {
                const admitted = await this.expire.enqueue({ command, traceId });
                if (admitted.left) throw new Error(admitted.left.message);
            } });
    }

    async read(lobby: GroupRef, actor: RoomEventActor): Promise<RoomEvent.View | null> {
        const stored = await this.repository.read(lobby);
        await this.authority.read({ ...actor, lobby }, stored?.value ?? null, this.dependencies.nowEpochMs());
        return stored ? projectRoomEvent(stored.value, actor.principalId, this.dependencies.nowEpochMs()) : null;
    }

    async readOrganizer(lobby: GroupRef, actor: RoomEventActor): Promise<RoomEvent.OrganizerView> {
        const stored = await this.repository.read(lobby);
        if (!stored || stored.value.organizerId !== actor.principalId) {
            throw new GroupMutationAuthorizationError('Only the current event organizer can read the full roster.');
        }
        const { members } = await this.authority.read({ ...actor, lobby }, stored.value, this.dependencies.nowEpochMs());
        // A handover or closure may commit while the membership read is in flight.
        const current = await this.repository.read(lobby);
        if (!current || current.value.closed || current.value.organizerId !== actor.principalId) {
            throw new GroupMutationAuthorizationError('Organizer access has ended.');
        }
        return projectRoomEventOrganizerView(current.value, members);
    }

    private async execute(input: RoomEventMutation, context: AppInboxMessageContext<TemporaryEventService.Result>) {
        const before = await this.repository.read(input.lobby);
        const nowEpochMs = this.dependencies.nowEpochMs();
        const authority = await this.authority.read(input, before?.value ?? null, nowEpochMs);
        validateEventAlertConsent(input.command, this.dependencies.webPush);
        if (input.command.action === 'claim' && !!authority.guestLease !== !!input.courtTransport) {
            throw new TypeError('A guest claiming a court must bind its own court session.');
        }
        const after = nextEventForPlayer({ before: before?.value ?? null, input, nowEpochMs, handoverWindowMs: this.config.handoverWindowMs });
        const result = { revision: after.revision };
        if (after === before?.value) return await this.dependencies.appInbox.commit(context, result, async () => {});
        return await this.commit({ before, after, actor: input, command: input.command, authority, requestId: input.requestId,
            traceId: context.message.id.traceId, nowEpochMs, courtTransport: input.courtTransport }, context, result);
    }

    private async settle(deadline: RoomEventDeadline, context: AppInboxMessageContext<RoomEventDeadline>) {
        const before = await this.repository.read(deadline.lobby);
        // Delivery established that the wake is due on its worker. A second writer's clock may trail that observation.
        const nowEpochMs = Math.max(this.dependencies.nowEpochMs(), deadline.dueAtEpochMs);
        if (!before || before.value.closed) return await this.dependencies.appInbox.commit(context, deadline, async () => {});
        const event = before.value;
        let command: RoomEvent.Command = { action: 'settle' };
        const fences: RuntimeStateGuardedBatchEffect[] = [];
        if (deadline.kind !== 'allocation' && nowEpochMs < event.closesAt) {
            const lifetime = await readRoomEventLifetime(this.dependencies.groups, event);
            if (nowEpochMs < lifetime.dueAt) {
                const signals = deadline.kind === 'idle' && lifetime.dueAt < event.closesAt ? [
                    roomEventSignal({ ...deadline, dueAtEpochMs: lifetime.dueAt }, {
                        serviceId: this.config.serviceId, traceId: context.message.id.traceId, createdAtEpochMs: nowEpochMs
                    })
                ] : [];
                return await this.dependencies.appInbox.commit(context, deadline, tx => writeAppOutboxInserts(tx, signals));
            }
            for (const { ref, authority } of lifetime.rooms) {
                const stored = authority.group;
                if (!stored) throw new TypeError('An active event is missing a room.');
                fences.push({ effectId: 'event-room:' + ref.groupId, ...groupStateUpdateGroupDescriptor(stored.value, stored.entry.revision) },
                    ...computeArchivePresenceFences(authority, ref, nowEpochMs));
            }
            command = { action: 'close' };
        }
        const after = changeRoomEvent({ event, command, principalId: event.organizerId, nowEpochMs });
        if (after === before.value) return await this.dependencies.appInbox.commit(context, deadline, async () => {});
        const audience = (await this.dependencies.groups.listMembers(deadline.lobby)).filter(member => member.status === 'active')
            .map(member => member.principalId);
        return await this.commit({ before, after, actor: null, command, nowEpochMs, traceId: context.message.id.traceId,
            requestId: roomEventDeadlineRoute(deadline).resourceId, authority: { audience, fences } }, context, deadline);
    }

    private async commit<Result>(transition: EventTransition, context: AppInboxMessageContext<Result>, result: Result): Promise<Result> {
        const { before, after, authority, nowEpochMs, traceId } = transition;
        decodeRoomEvent(after);
        const writes = await this.dependencies.roomAccess.prepare({ before: before?.value ?? null, after, lobbyRef: after.lobby,
            command: transition.command, actor: transition.actor, guestTransport: transition.courtTransport, actorGuestLease: authority.guestLease,
            requestId: transition.requestId, nowEpochMs, traceId });
        const publication = this.repository.prepare(before, after, remainingAuthorityFences(authority.fences, writes), {
            createdAtEpochMs: nowEpochMs, retentionMs: this.config.finishedRetentionMs, serviceId: this.config.serviceId, traceId, audience: authority.audience
        });
        return await this.dependencies.appInbox.commit(context, result, async transaction => {
            await writeGuardedViewPublication(transaction, publication);
            await this.dependencies.roomAccess.write(transaction, writes);
        });
    }
}

interface NextPlayerEvent {
    readonly before: RoomEvent | null;
    readonly input: RoomEventMutation;
    readonly nowEpochMs: number;
    readonly handoverWindowMs: number;
}

function nextEventForPlayer({ before, input, nowEpochMs, handoverWindowMs }: NextPlayerEvent): RoomEvent {
    if (input.command.action === 'create') {
        if (before) throw new TypeError('This lobby already has an event.');
        return createRoomEvent({ lobby: input.lobby, organizerId: input.principalId, command: input.command, nowEpochMs });
    }
    if (!before) throw new TypeError('This lobby has no event.');
    return changeRoomEvent({ event: before, principalId: input.principalId, command: input.command, nowEpochMs, handoverWindowMs });
}

function decodeEventResult(value: unknown): TemporaryEventService.Result {
    const row = requireRecord(value, 'Event result');
    requireExactKeys(row, ['revision'], 'Event result');
    requirePositiveInteger(row.revision, 'Event revision');
    return { revision: Number(row.revision) };
}

/** A room write may already guard exactly the group or session that granted authority. Never advance that row twice. */
function remainingAuthorityFences(fences: readonly RuntimeStateGuardedBatchEffect[], writes: readonly GroupMutationComputedWrite[]) {
    const rows = writes.flatMap(write => [write.persistence.guardedBatch.guard, ...write.persistence.guardedBatch.effects]);
    return fences.filter(fence => {
        const overlapping = rows.find(row => row.namespace === fence.namespace && row.key === fence.key);
        if (!overlapping) return true;
        // A claimed player may have no presence yet. The seat release already guards that admission's absence.
        if (fence.operation === 'insert' && overlapping.operation === 'insert') return false;
        if (!('expectedRevision' in overlapping) || !('expectedRevision' in fence) || overlapping.expectedRevision !== fence.expectedRevision) {
            throw new RuntimeStateWriteConflictError();
        }
        return false;
    });
}
