import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import { validateALOutboundRecipientScope } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import type { PublishRallarServerWsMessageInput } from './publish-rallar-server-ws-message.ts';

/** A message that names a group is scoped by it; any other unicast needs the scope its caller proved. */
export function validateRallarServerWsPublishScope(
    input: Pick<PublishRallarServerWsMessageInput, 'message' | 'inboundScope' | 'origin'>
): readonly string[] {
    if (readALTargetGroupRef(input.message) !== undefined) {
        return input.origin === 'server' && input.inboundScope !== undefined
            ? ['A group-addressed publication takes its scope from targets.groupRef']
            : [];
    }
    return input.message.targets?.mode === 'unicast'
        ? validateALOutboundRecipientScope(input.inboundScope)
        : [];
}
