import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { ALAdmissionCorruptionError } from '../../alm/al-admission-decoder.ts';
import type { ALOutboundAdmissionStore } from '../../alm/outbound/admission/al-outbound-admission-store.ts';
import { validateALOutboundRecipientScope } from '../../alm/outbound/admission/al-outbound-admission-validation.ts';
import { toALOutboundIdentityKey } from '../../alm/outbound/al-outbound-canonical-message.ts';
import type { ALOutboundDequeueAuthority } from '../../alm/outbound/al-outbound-message-runtime.ts';
import { EnqueuedType } from '../../api/api-config.ts';
import type { StateScope } from '../../api/state-types.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import {
    isWsQueueBoxServerDirectScopedBroadcastRow,
    requiresWsQueueBoxServerRecipientScope,
    validateWsQueueBoxServerDirectScopedBroadcastAuthority,
    validateWsQueueBoxServerRecipientAuthority
} from './requires-ws-queue-box-server-recipient-scope.ts';
import type { WsQueueBoxServerPreparedMessage } from './ws-queue-box-server-outbound-planning.ts';

/** Auth invalidation is a separate session-global authority from ordinary scoped delivery. */
export type WsOutboxProducerAuthority =
    | {
        readonly admittedAudience: readonly string[];
        readonly recipientScope: StateScope;
        readonly sessionInvalidation?: never;
    }
    | {
        readonly admittedAudience: readonly string[];
        readonly recipientScope: undefined;
        readonly sessionInvalidation: NonNullable<ALOutboundDequeueAuthority['sessionInvalidation']>;
    };

export type WsOutboxProducerProvenanceReader = (
    message: ALMessage,
    entry: ResourceEntry
) => Promise<WsOutboxProducerAuthority>;

export namespace WsQueueBoxServerDequeueAuthority {
    export interface Dependencies {
        readonly admissionStore: ALOutboundAdmissionStore<WsQueueBoxServerPreparedMessage>;
        readonly outbox: QueueBoxResourceEntryRepository;
        readonly readProducerProvenance: WsOutboxProducerProvenanceReader | undefined;
    }
}

/** Classifies the observed queue row before the generic admission owner may create any facts. */
export class WsQueueBoxServerDequeueAuthority {
    private readonly dependencies: WsQueueBoxServerDequeueAuthority.Dependencies;

    constructor(dependencies: WsQueueBoxServerDequeueAuthority.Dependencies) {
        this.dependencies = dependencies;
    }

    async readDequeueAuthority(message: ALMessage, entry: ResourceEntry): Promise<ALOutboundDequeueAuthority> {
        const { admissionStore, outbox, readProducerProvenance } = this.dependencies;
        if (entry.typeId !== EnqueuedType.WS_OUTBOX) {
            throw toDequeueCorruption(entry, 'Unexpected WS outbox row type');
        }
        if (await admissionStore.hasSentMessageAdmission(message.id.msgId)) {
            const policy = await admissionStore.readCapturedPolicy(message, entry);
            if (validateWsQueueBoxServerRecipientAuthority(message, policy, entry.key).length > 0) {
                throw toDequeueCorruption(entry, 'Captured public unicast has no recipient scope');
            }
            return {
                admittedAudience: policy.admittedAudience,
                recipientScope: policy.recipientScope,
                sessionInvalidation: policy.sessionInvalidation
            };
        }
        if (entry.key.topicId === 'AL_OUTBOUND_MESSAGE' || await outbox.getItem(toALOutboundIdentityKey(entry.key))) {
            throw toDequeueCorruption(entry, 'Canonical identity has no sent admission');
        }
        const directBroadcast = isWsQueueBoxServerDirectScopedBroadcastRow(message, entry.key);
        if (!readProducerProvenance || (!requiresWsQueueBoxServerRecipientScope(message) && !directBroadcast)) {
            throw toDequeueCorruption(entry, 'Raw WS outbox row has no supported producer authority');
        }
        const authority = await readProducerProvenance(message, entry);
        if (authority.sessionInvalidation !== undefined) {
            if (validateWsQueueBoxServerRecipientAuthority(message, authority, entry.key).length > 0) {
                throw toDequeueCorruption(entry, 'Invalid exact-session producer authority');
            }
            return authority;
        }
        const targets = message.targets;
        if (
            validateALOutboundRecipientScope(authority.recipientScope).length > 0 ||
            (directBroadcast
                ? validateWsQueueBoxServerDirectScopedBroadcastAuthority(message, authority).length > 0
                : targets?.mode !== 'unicast' ||
                    authority.admittedAudience.some((peerId) => peerId !== targets.toPeerId))
        ) {
            throw toDequeueCorruption(entry, 'Producer authority differs from scoped unicast target');
        }
        return authority;
    }
}

function toDequeueCorruption(entry: ResourceEntry, reason: string): ALAdmissionCorruptionError {
    return new ALAdmissionCorruptionError(JSON.stringify(entry.key), new TypeError(reason));
}
