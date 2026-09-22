import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALQosEffectivePolicy, ALQosMessageContext } from '@shared/al-contracts/al-policy.ts';

/** Only the explicitly marked lifecycle specimen shares a latest-wins slot. */
export function computeAlmConformanceQosDefaults(
    message: ALMessage,
    context: ALQosMessageContext
): Partial<ALQosEffectivePolicy> | undefined {
    if (context.direction !== 'outbound' || !isSupersedenceSpecimen(message.payload.resource)) {
        return undefined;
    }
    const room = readALTargetGroupRef(message);
    if (room === undefined) {
        return undefined;
    }
    return {
        supersedence: {
            algo: 'latest-wins',
            opts: {
                supersedenceKey: JSON.stringify([
                    message.id.senderId,
                    room.applicationId,
                    room.workspaceId,
                    room.groupId,
                    message.payload.typeId
                ])
            }
        }
    };
}

function isSupersedenceSpecimen(serialized: string): boolean {
    try {
        const payload: unknown = JSON.parse(serialized);
        return typeof payload === 'object' && payload !== null &&
            'marker' in payload && payload.marker === 'delivery-lifecycle' &&
            'specimen' in payload && payload.specimen === 'supersedence';
    }
    catch {
        return false;
    }
}
