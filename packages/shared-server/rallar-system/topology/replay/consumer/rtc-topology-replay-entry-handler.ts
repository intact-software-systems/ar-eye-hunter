import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { WsServerLiveSendStatus } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';

import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toCanonicalRtcTopologyGroupIdentity } from '../../persistence/rtc-topology-identifiers.ts';
import type { RtcTopologyPublication } from '../../publication/rtc-topology-publication.ts';
import type { RtcTopologyDeliveryLogEntry } from '../delivery/rtc-topology-delivery-contracts.ts';
import type {
    RtcTopologyReplayEntryHandler,
    RtcTopologyReplayEntryHandlingResult
} from './rtc-topology-replay-contracts.ts';
import { decideRtcTopologyReplayEntry } from './rtc-topology-replay-decision.ts';

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
    /** The accepted slot: repair pins to it whenever it exists (plan slice 4c). */
    readonly acceptedSnapshots: RtcTopologyReplaySnapshotReader;
    readonly sender: RtcTopologyReplayLiveSender;
}

export class RtcTopologyReplayEntryHandlerService implements RtcTopologyReplayEntryHandler {
    readonly #publications: RtcTopologyReplayPublicationReader;
    readonly #outbox: RtcTopologyReplayOutboxReader;
    readonly #snapshots: RtcTopologyReplaySnapshotReader;
    readonly #acceptedSnapshots: RtcTopologyReplaySnapshotReader;
    readonly #sender: RtcTopologyReplayLiveSender;

    constructor(options: RtcTopologyReplayEntryHandlerOptions) {
        this.#publications = options.publications;
        this.#outbox = options.outbox;
        this.#snapshots = options.snapshots;
        this.#acceptedSnapshots = options.acceptedSnapshots;
        this.#sender = options.sender;
    }

    async handle(
        entry: RtcTopologyDeliveryLogEntry,
        databaseNowEpochMs: number,
        signal: AbortSignal
    ): Promise<RtcTopologyReplayEntryHandlingResult> {
        throwIfAborted(signal);
        const [publication, outbox, acceptedSnapshot, plannedSnapshot] = await Promise.all([
            this.#publications.findPublication(entry.groupRef, entry.publicationId),
            this.#outbox.getItem(entry.outboxKey),
            this.#acceptedSnapshots.findSnapshot(entry.groupRef),
            this.#snapshots.findSnapshot(entry.groupRef)
        ]);
        throwIfAborted(signal);

        // The decision compares against the planned row: it is written in the
        // same transaction as every publication, so the log can never run
        // ahead of it — the invariant the corruption checks enforce. The
        // accepted row is promoted asynchronously and may trail the log
        // indefinitely under a hold landing, so it must not be the
        // comparison baseline.
        const decision = decideRtcTopologyReplayEntry({
            entry,
            publication,
            outbox,
            currentSnapshot: plannedSnapshot,
            databaseNowEpochMs
        });
        if (decision.status === 'gap') {
            return decision;
        }

        // Repair content converges members on the layout carrying traffic:
        // the accepted row whenever a promotion has produced one, the planned
        // row only before that (product decisions 24/30, plan slice 4c).
        const isCurrentRepair = decision.status === 'deliver-current';
        const message = isCurrentRepair
            ? materializeRtcTopologyCurrentRepairMessage({
                entry,
                currentSnapshot: acceptedSnapshot ?? decision.currentSnapshot,
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
    return decodePersistedALMessageValue(message);
}

function throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) {
        return;
    }
    throw signal.reason ?? new DOMException('RTC topology replay aborted', 'AbortError');
}
