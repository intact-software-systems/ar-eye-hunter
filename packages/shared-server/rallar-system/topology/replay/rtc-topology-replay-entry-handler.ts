import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { WsServerLiveSendStatus } from '@shared/services/ws-queue-box-server-contracts.ts';

import { toCanonicalRtcTopologyGroupIdentity } from '../../rtc-topology-identifiers.ts';
import type { RtcTopologyPublication } from '../../rtc-topology-publication-contract.ts';
import { validatePersistedALMessage } from '../../services/al-message-persistence-validation.ts';
import type { RtcTopologyDeliveryLogEntry } from './rtc-topology-delivery-contracts.ts';
import { decideRtcTopologyReplayEntry } from './rtc-topology-replay-decision.ts';
import type {
    RtcTopologyReplayEntryHandler,
    RtcTopologyReplayEntryHandlingResult
} from './rtc-topology-replay-service.ts';

interface RtcTopologyReplayPublicationReader {
    findPublication(
        groupRef: GroupRef,
        publicationId: string
    ): Promise<RtcTopologyPublication | undefined>;
}

interface RtcTopologyReplayOutboxReader {
    getItem(key: Key): Promise<ResourceEntry | undefined>;
}

interface RtcTopologyReplaySnapshotReader {
    findSnapshot(groupRef: GroupRef): Promise<RallarOverlayTopologySnapshot | undefined>;
}

interface RtcTopologyReplayLiveSender {
    sendToTargetsWithResult(message: ALMessage): Readonly<{ status: WsServerLiveSendStatus; }>;
}

interface RtcTopologyReplayEntryHandlerOptions {
    readonly publications: RtcTopologyReplayPublicationReader;
    readonly outbox: RtcTopologyReplayOutboxReader;
    readonly snapshots: RtcTopologyReplaySnapshotReader;
    readonly sender: RtcTopologyReplayLiveSender;
}

export class RtcTopologyReplayEntryHandlerService implements RtcTopologyReplayEntryHandler {
    readonly #publications: RtcTopologyReplayPublicationReader;
    readonly #outbox: RtcTopologyReplayOutboxReader;
    readonly #snapshots: RtcTopologyReplaySnapshotReader;
    readonly #sender: RtcTopologyReplayLiveSender;

    constructor(options: RtcTopologyReplayEntryHandlerOptions) {
        this.#publications = options.publications;
        this.#outbox = options.outbox;
        this.#snapshots = options.snapshots;
        this.#sender = options.sender;
    }

    async handle(
        entry: RtcTopologyDeliveryLogEntry,
        databaseNowEpochMs: number,
        signal: AbortSignal
    ): Promise<RtcTopologyReplayEntryHandlingResult> {
        throwIfAborted(signal);
        const [publication, outbox, currentSnapshot] = await Promise.all([
            this.#publications.findPublication(entry.groupRef, entry.publicationId),
            this.#outbox.getItem(entry.outboxKey),
            this.#snapshots.findSnapshot(entry.groupRef)
        ]);
        throwIfAborted(signal);

        const decision = decideRtcTopologyReplayEntry({
            entry,
            publication,
            outbox,
            currentSnapshot,
            databaseNowEpochMs
        });
        if (decision.status === 'gap') {
            return decision;
        }

        const isCurrentRepair = decision.status === 'deliver-current';
        const message = isCurrentRepair
            ? materializeRtcTopologyCurrentRepairMessage({
                entry,
                currentSnapshot: decision.currentSnapshot,
                databaseNowEpochMs
            })
            : decision.message;
        throwIfAborted(signal);
        const result = this.#sender.sendToTargetsWithResult(message);
        if (result.status === 'no-recipients') {
            return { status: 'no-local-recipient' };
        }
        if (result.status !== 'sent-live') {
            return { status: 'send-failed' };
        }
        return { status: isCurrentRepair ? 'current-repair' : 'delivered' };
    }
}

interface CurrentRepairMessageInput {
    readonly entry: RtcTopologyDeliveryLogEntry;
    readonly currentSnapshot: RallarOverlayTopologySnapshot;
    readonly databaseNowEpochMs: number;
}

export function materializeRtcTopologyCurrentRepairMessage(
    input: CurrentRepairMessageInput
): ALMessage {
    const { entry, currentSnapshot, databaseNowEpochMs } = input;
    const revision = currentSnapshot.sourceGroupStateCausalRevision;
    const message: ALMessage = {
        id: {
            v: 2,
            msgId: JSON.stringify([
                'rtc-topology-current-repair',
                toCanonicalRtcTopologyGroupIdentity(entry.groupRef),
                revision.groupRevision,
                revision.presenceRevision,
                currentSnapshot.version
            ]),
            ts: databaseNowEpochMs,
            senderId: 'rallar-server'
        },
        route: {
            topicId: AppTopics.overlayTopology,
            contextId: entry.groupRef.groupId,
            resourceId: `${currentSnapshot.overlayId}:${revision.groupRevision}:` +
                `${revision.presenceRevision}:${currentSnapshot.version}`
        },
        constraints: { expiresAtMs: entry.retainUntilEpochMs },
        targets: {
            mode: 'broadcast',
            scope: 'room',
            groupRef: entry.groupRef,
            recipientPeerIds: [...currentSnapshot.activeSessionIds]
        },
        delivery: { reliability: 'best-effort', ack: 'none' },
        payload: {
            typeId: AppTopics.overlayTopology,
            contentType: 'application/json',
            resource: JSON.stringify(currentSnapshot)
        },
        audit: { createdBy: 'rallar-server', createdTs: databaseNowEpochMs }
    };
    validatePersistedALMessage(message);
    return message;
}

function throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) {
        return;
    }
    throw signal.reason ?? new DOMException('RTC topology replay aborted', 'AbortError');
}
