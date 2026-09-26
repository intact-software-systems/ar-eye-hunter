import type { ALDurabilityAlgo } from '@shared/al-contracts/al-policy.ts';
import { AL_CHANNEL_PURPOSES } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

/** The definition as a JavaScript caller may pass it: any string, or nothing, in either field. */
export interface RallarTypedChannelPolicyInput {
    readonly purpose?: string;
    readonly durability?: string;
}

const AL_DURABILITIES: readonly ALDurabilityAlgo[] = ['volatile', 'local-outbox', 'local-inbox'];

/** A realtime purpose belongs to `rallar.realtime` (D15, D52). */
export function validateRallarTypedChannelPolicy(
    definition: RallarTypedChannelPolicyInput
): readonly RallarValidationIssue[] {
    const issues: RallarValidationIssue[] = [];
    if (definition.purpose === 'realtime') {
        issues.push({
            path: '$.purpose',
            code: 'unsupported',
            message: 'A realtime channel belongs to rallar.realtime; a typed channel is a command or a notification.'
        });
    }
    else if (!AL_CHANNEL_PURPOSES.some((candidate) => candidate === definition.purpose)) {
        issues.push({
            path: '$.purpose',
            code: 'invalid-purpose',
            message: 'Purpose must be command or notification.'
        });
    }
    if (
        definition.durability !== undefined &&
        !AL_DURABILITIES.some((candidate) => candidate === definition.durability)
    ) {
        issues.push({
            path: '$.durability',
            code: 'invalid-durability',
            message: 'Durability must be volatile, local-outbox or local-inbox.'
        });
    }
    return issues;
}
