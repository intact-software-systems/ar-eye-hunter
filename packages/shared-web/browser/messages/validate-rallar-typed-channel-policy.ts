import { AL_DURABILITY_ALGOS } from '@shared/al-contracts/al-policy.ts';
import { decodeALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import { AL_CHANNEL_PURPOSES } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

import type {
    RallarStorageUnavailablePolicy,
    RallarTypedMessageChannelDefinition
} from './rallar-message-contracts.ts';

/** The definition as a JavaScript caller may pass it: any string, or nothing, in each field. */
export interface RallarTypedChannelPolicyInput {
    readonly topicId?: string;
    readonly purpose?: string;
    readonly access?: string;
    readonly durability?: string;
    readonly onStorageUnavailable?: string;
    readonly recovery?: unknown;
    readonly publication?: unknown;
    readonly order?: string;
    readonly onOrderGap?: unknown;
}

const RALLAR_STORAGE_UNAVAILABLE_POLICIES: readonly RallarStorageUnavailablePolicy[] = ['refuse', 'volatile'];
const RALLAR_TYPED_CHANNEL_ACCESSES: readonly RallarTypedMessageChannelDefinition['access'][] = ['members', 'granted'];

/** A realtime purpose belongs to `rallar.realtime` (D15, D52). */
export function validateRallarTypedChannelPolicy(
    definition: RallarTypedChannelPolicyInput
): readonly RallarValidationIssue[] {
    const issues: RallarValidationIssue[] = [];
    if (definition.purpose === 'realtime') {
        issues.push({
            path: '$.purpose',
            code: 'unsupported',
            message:
                'A realtime channel belongs to rallar.realtime; a typed channel is a command, a notification or a live channel.'
        });
    }
    else if (!AL_CHANNEL_PURPOSES.some((candidate) => candidate === definition.purpose)) {
        issues.push({
            path: '$.purpose',
            code: 'invalid-purpose',
            message: 'Purpose must be command, notification or live.'
        });
    }
    issues.push(...validateRallarChannelAccess(definition));
    issues.push(...validateRallarChannelDurability(definition));
    if (
        definition.onStorageUnavailable !== undefined &&
        !RALLAR_STORAGE_UNAVAILABLE_POLICIES.some((candidate) => candidate === definition.onStorageUnavailable)
    ) {
        issues.push({
            path: '$.onStorageUnavailable',
            code: 'invalid-on-storage-unavailable',
            message: 'onStorageUnavailable must be refuse or volatile.'
        });
    }
    issues.push(...validateRallarChannelRecovery(definition.recovery));
    issues.push(...validateRallarChannelPublication(definition));
    issues.push(...validateRallarChannelOrder(definition));
    return issues;
}

/** Grants are per exact topic, so a granted channel names the topic it publishes on (D500). */
function validateRallarChannelAccess(definition: RallarTypedChannelPolicyInput): readonly RallarValidationIssue[] {
    if (!RALLAR_TYPED_CHANNEL_ACCESSES.some((candidate) => candidate === definition.access)) {
        return [{ path: '$.access', code: 'invalid-access', message: 'Access must be members or granted.' }];
    }
    return definition.access === 'granted' && definition.topicId === undefined
        ? [{ path: '$.topicId', code: 'missing-topic-id', message: 'A granted channel names its topicId.' }]
        : [];
}

/** A live channel's values never wait in storage, so it declares no durability but `volatile` (D466). */
function validateRallarChannelDurability(definition: RallarTypedChannelPolicyInput): readonly RallarValidationIssue[] {
    const { durability } = definition;
    if (durability === undefined) {
        return [];
    }
    if (!AL_DURABILITY_ALGOS.some((candidate) => candidate === durability)) {
        return [{
            path: '$.durability',
            code: 'invalid-durability',
            message: 'Durability must be volatile, local-checkpoint, local-outbox or local-inbox.'
        }];
    }
    return definition.purpose === 'live' && durability !== 'volatile'
        ? [{ path: '$.durability', code: 'invalid-durability', message: 'A live channel is volatile.' }]
        : [];
}

/** Absent is valid: the channel declares no owner. Stated, it must be callable. */
function validateRallarChannelRecovery(recovery: unknown): readonly RallarValidationIssue[] {
    if (recovery === undefined) {
        return [];
    }
    const onResyncRequired = typeof recovery === 'object' && recovery !== null && 'onResyncRequired' in recovery
        ? recovery.onResyncRequired
        : undefined;
    if (typeof onResyncRequired === 'function') {
        return [];
    }
    return [{
        path: '$.recovery.onResyncRequired',
        code: 'invalid-recovery',
        message: 'recovery.onResyncRequired must be a function.'
    }];
}

/** Only a live channel paces its sends, and it always declares how (D466). */
function validateRallarChannelPublication(definition: RallarTypedChannelPolicyInput): readonly RallarValidationIssue[] {
    if (definition.purpose !== 'live') {
        return definition.publication === undefined
            ? []
            : [{ path: '$.publication', code: 'unsupported', message: 'Only a live channel declares a publication.' }];
    }
    if (definition.publication === undefined) {
        return [{
            path: '$.publication',
            code: 'missing-publication',
            message: 'A live channel declares its publication: cadenceMs, retainNewest and drain.'
        }];
    }
    return decodeALPublicationPolicy(definition.publication).left ?? [];
}

/**
 * Edge order lives in memory at the two ends and waits only for a send that is retried, so its channel is a
 * volatile command or notification channel. A granted topic is refused until its wrapped payload is proven through
 * the publisher proof and the `subscribe` election; a session that elects late is a late joiner like any other.
 */
function validateRallarChannelOrder(definition: RallarTypedChannelPolicyInput): readonly RallarValidationIssue[] {
    if (definition.order === undefined) {
        return definition.onOrderGap === undefined
            ? []
            : [{
                path: '$.onOrderGap',
                code: 'unsupported',
                message: 'Only an edge-ordered channel reports order gaps.'
            }];
    }
    const refusal = definition.order === 'edge' ? resolveRallarEdgeOrderRefusal(definition) : undefined;
    return [
        ...(definition.order === 'edge'
            ? []
            : [{ path: '$.order', code: 'invalid-order', message: 'Order must be edge.' }]),
        ...(refusal === undefined ? [] : [{ path: '$.order', code: 'unsupported', message: refusal }]),
        ...(definition.onOrderGap === undefined || typeof definition.onOrderGap === 'function'
            ? []
            : [{ path: '$.onOrderGap', code: 'invalid-order-gap-handler', message: 'onOrderGap must be a function.' }])
    ];
}

function resolveRallarEdgeOrderRefusal(definition: RallarTypedChannelPolicyInput): string | undefined {
    if (definition.purpose === 'live') {
        return 'A live channel is not edge-ordered: nothing retries its sends.';
    }
    if (definition.access === 'granted') {
        return 'A granted channel is not edge-ordered yet: its signed payload is not proven with the order wrapper.';
    }
    return definition.durability !== undefined && definition.durability !== 'volatile'
        ? 'An edge-ordered channel is volatile: its order lives in memory only.'
        : undefined;
}
