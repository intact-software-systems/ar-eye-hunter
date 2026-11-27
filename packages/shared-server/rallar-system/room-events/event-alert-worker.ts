import { roomGuestAccessMode } from '@shared/api/room-guests/access.ts';
import { withoutEventAlerts } from '@shared/api/room-events/room-event-alerts.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { RallarServerAppInbox } from '../../rallar-server/rallar-server-app-inbox.ts';
import type { AppInboxMessageContext } from '../app-inbox/app-inbox-contracts.ts';
import { AppOutboxType } from '../app-outbox/app-outbox-type.ts';
import { installDurableDeadline, type DurableDeadlineDelivery } from '../app-outbox/install-durable-deadline.ts';
import type { GroupStateRepository } from '../group-state/persistence/group-state-repository.ts';
import { decodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import { writeGuardedViewPublication } from '../websocket/outbox/guarded-view-publication.ts';
import { deliverCourtAlert } from './deliver-court-alert.ts';
import type { EventWebPush } from './event-web-push.ts';
import { decodeRoomEventCourtAlert, roomEventCourtAlertRoute, ROOM_EVENT_COURT_ALERT_TOPIC, type RoomEventCourtAlert } from './room-event-court-alert.ts';
import type { RoomEventRepository } from './room-event-repository.ts';

export namespace EventAlertWorker {
    export interface Dependencies {
        readonly appInbox: RallarServerAppInbox;
        readonly groups: GroupStateRepository;
        readonly repository: RoomEventRepository;
        readonly provider: EventWebPush;
        readonly nowEpochMs: () => number;
        readonly finishedRetentionMs: number;
        readonly serviceId: string;
    }
}

/** Provider calls happen after the seat commits. A terminal response retires the exact observed device via AppInbox. */
export class EventAlertWorker {
    private readonly dependencies: EventAlertWorker.Dependencies;
    private readonly retire: RallarServerAppInbox.Operation<RoomEventCourtAlert, RoomEventCourtAlert>;

    constructor(dependencies: EventAlertWorker.Dependencies) {
        this.dependencies = dependencies;
        this.retire = dependencies.appInbox.register({
            type: 'app:rallar-events:retire-device', decodeEnvelope: ({ data }) => decodeRoomEventCourtAlert(data),
            encodeEnvelope: alert => ({ data: decodeJsonWireValue(alert, 'Retire event device') }),
            toBinding: alert => roomEventCourtAlertRoute(alert),
            toLogicalCommand: alert => decodeJsonWireValue(alert, 'Retire event device'), materialize: alert => alert,
            encodeResult: alert => decodeJsonWireValue(alert, 'Retired event device'),
            decodeResult: (value, command) => {
                const result = decodeRoomEventCourtAlert(value);
                if (!jsonEquals(result, command)) throw new TypeError('Device retirement acknowledgement changed.');
                return result;
            },
            handle: (alert, context) => this.retireDevice(alert, context)
        });
    }

    listen(input: Pick<DurableDeadlineDelivery<RoomEventCourtAlert>, 'database' | 'outboxQueueReader'>): void {
        const { provider, repository, nowEpochMs, finishedRetentionMs } = this.dependencies;
        installDurableDeadline({ ...input, typeId: AppOutboxType.ROOM_EVENT_COURT_ALERT, topicId: ROOM_EVENT_COURT_ALERT_TOPIC,
            decode: decodeRoomEventCourtAlert, route: roomEventCourtAlertRoute, retentionMs: finishedRetentionMs, nowEpochMs,
            enqueue: (alert, traceId) => deliverCourtAlert(alert, { nowEpochMs,
                readEvent: async lobby => (await repository.read(lobby))?.value ?? null,
                canReceive: (lobby, principalId, now) => this.canReceive(lobby, principalId, now),
                send: (device, current, deadline) => provider.send(device, current, deadline),
                retireDevice: async current => {
                    const result = await this.retire.enqueue({ command: current, traceId });
                    if (result.left) throw new Error(result.left.message);
                }
            }) });
    }

    private async canReceive(ref: GroupRef, principalId: string, now: number): Promise<boolean> {
        const { groups } = this.dependencies;
        const [group, member] = await Promise.all([groups.findGroup(ref), groups.findMember({ ...ref, principalId })]);
        return !!group && !!member && group.status === 'active' && member.status === 'active' &&
            (group.expiresAtEpochMs === null || group.expiresAtEpochMs > now) &&
            (!member.guestLease || roomGuestAccessMode(group, member, now) === 'room') && await groups.isTemporaryGroupAvailable(group, now);
    }

    private async retireDevice(alert: RoomEventCourtAlert, context: AppInboxMessageContext<RoomEventCourtAlert>): Promise<RoomEventCourtAlert> {
        const { repository, appInbox, nowEpochMs, finishedRetentionMs, serviceId } = this.dependencies;
        const before = await repository.read(alert.lobby);
        if (!before) return appInbox.commit(context, alert, async () => {});
        const after = withoutEventAlerts(before.value, device => device.principalId === alert.principalId && device.revision === alert.consentRevision);
        if (after === before.value) return appInbox.commit(context, alert, async () => {});
        const publication = repository.prepare(before, { ...after, revision: after.revision + 1 }, [], {
            audience: [alert.principalId], createdAtEpochMs: nowEpochMs(), retentionMs: finishedRetentionMs, serviceId, traceId: context.message.id.traceId
        });
        return appInbox.commit(context, alert, transaction => writeGuardedViewPublication(transaction, publication));
    }
}
