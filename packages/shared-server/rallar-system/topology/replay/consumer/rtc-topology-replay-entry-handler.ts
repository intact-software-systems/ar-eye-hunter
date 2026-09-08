import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { WsServerLiveSendStatus } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';

import { computeStateSnapshotPages } from '@shared/api/state-snapshot-page.ts';
import { toCanonicalRtcTopologyGroupIdentity } from '../../persistence/rtc-topology-identifiers.ts';
import type { RtcTopologyPublication } from '../../publication/rtc-topology-publication.ts';
import { computeRtcTopologyPublicationOutbox } from '../../publication/rtc-topology-ws-outbox-entry.ts';
import { toDeliverableTopologySnapshot } from '../deliverable-topology-snapshot.ts';
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

export namespace RtcTopologyReplayEntryHandlerService {
    export interface Options {
        readonly publications: RtcTopologyReplayPublicationReader;
        readonly outbox: RtcTopologyReplayOutboxReader;
        readonly snapshots: RtcTopologyReplaySnapshotReader;
        /** The accepted slot: repair pins to it whenever it exists (plan slice 4c). */
        readonly acceptedSnapshots: RtcTopologyReplaySnapshotReader;
        readonly sender: RtcTopologyReplayLiveSender;
    }
}

export class RtcTopologyReplayEntryHandlerService implements RtcTopologyReplayEntryHandler {
    readonly #publications: RtcTopologyReplayPublicationReader;
    readonly #outbox: RtcTopologyReplayOutboxReader;
    readonly #snapshots: RtcTopologyReplaySnapshotReader;
    readonly #acceptedSnapshots: RtcTopologyReplaySnapshotReader;
    readonly #sender: RtcTopologyReplayLiveSender;

    constructor(options: RtcTopologyReplayEntryHandlerService.Options) {
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
        // The decision compares against the planned row: it is written in the
        // same transaction as every publication, so the log can never run
        // ahead of it — the invariant the corruption checks enforce. The
        // asynchronously promoted accepted row may trail the log and is read
        // only when the rare repair branch needs delivery content.
        const [publication, plannedSnapshot] = await Promise.all([
            this.#publications.findPublication(entry.groupRef, entry.publicationId),
            this.#snapshots.findSnapshot(entry.groupRef)
        ]);
        const outbox = publication
            ? await Promise.all(
                computeRtcTopologyPublicationOutbox(publication).map((page) => this.#outbox.getItem(page.key))
            )
            : undefined;
        throwIfAborted(signal);

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

        const isCurrentRepair = decision.status === 'deliver-current';
        const messages = isCurrentRepair
            ? materializeRtcTopologyCurrentRepairMessages({
                entry,
                currentSnapshot: toDeliverableTopologySnapshot({
                    planned: decision.currentSnapshot,
                    accepted: await this.#acceptedSnapshots.findSnapshot(entry.groupRef)
                }) ?? decision.currentSnapshot,
                databaseNowEpochMs
            })
            : decision.messages;
        throwIfAborted(signal);
        return this.#sendPages({ messages, signal, isCurrentRepair });
    }

    #sendPages(input: SendRtcTopologyPagesInput): RtcTopologyReplayEntryHandlingResult {
        const { messages, signal, isCurrentRepair } = input;
        let delivered = false;
        for (const message of messages) {
            throwIfAborted(signal);
            const result = this.#sender.sendToTargetsWithResult(message);
            if (result.status === 'no-recipients') {
                continue;
            }
            if (result.status !== 'sent-live') {
                return { status: 'send-failed' };
            }
            delivered = true;
        }
        if (!delivered) {
            return { status: 'no-local-recipient' };
        }
        return { status: isCurrentRepair ? 'current-repair' : 'delivered' };
    }
}

interface SendRtcTopologyPagesInput {
    readonly messages: readonly ALMessage[];
    readonly signal: AbortSignal;
    readonly isCurrentRepair: boolean;
}

interface CurrentRepairMessageInput {
    readonly entry: RtcTopologyDeliveryLogEntry;
    readonly currentSnapshot: RallarOverlayTopologySnapshot;
    readonly databaseNowEpochMs: number;
}

export function materializeRtcTopologyCurrentRepairMessages(
    input: CurrentRepairMessageInput
): readonly ALMessage[] {
    const { entry, currentSnapshot, databaseNowEpochMs } = input;
    const revision = currentSnapshot.sourceGroupStateCausalRevision;
    const envelope = {
        id: {
            v: 2 as const,
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
        route: toAppQueueKey({
            topicId: AppTopics.overlayTopology,
            contextId: entry.groupRef.groupId,
            resourceId: `${currentSnapshot.overlayId}:${revision.groupRevision}:` +
                `${revision.presenceRevision}:${currentSnapshot.version}`
        }),
        constraints: { expiresAtMs: entry.retainUntilEpochMs },
        targets: {
            mode: 'broadcast' as const,
            scope: 'room' as const,
            groupRef: entry.groupRef,
            recipientPeerIds: [...currentSnapshot.activeSessionIds]
        },
        delivery: { reliability: 'best-effort' as const, ack: 'none' as const },
        audit: { createdBy: 'rallar-server', createdTs: databaseNowEpochMs }
    };
    return computeStateSnapshotPages({
        envelope,
        scope: {
            applicationId: entry.groupRef.applicationId,
            workspaceId: entry.groupRef.workspaceId,
            kind: 'group',
            resourceId: entry.groupRef.groupId
        },
        revision: JSON.stringify([revision.groupRevision, revision.presenceRevision, currentSnapshot.version]),
        resource: JSON.stringify(currentSnapshot)
    }).fold((issue) => {
        throw new TypeError(issue.message);
    }, (pages) => pages);
}

function throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) {
        return;
    }
    throw signal.reason ?? new DOMException('RTC topology replay aborted', 'AbortError');
}
