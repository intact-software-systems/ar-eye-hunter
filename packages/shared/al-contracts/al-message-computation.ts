import type { ALMessage, ALRoute } from './al-contract.ts';
import type { ALQosPolicyRequest } from './al-policy.ts';

export interface ALMessageConstructionFacts {
    readonly msgId: string;
    readonly nowEpochMs: number;
}

export interface ComputeALMessageInput<Resource> {
    readonly senderId: string;
    readonly route: ALRoute;
    readonly typeId: string;
    readonly resource: Resource;
    readonly facts: ALMessageConstructionFacts;
    readonly options?: Readonly<{
        qos?: ALQosPolicyRequest;
        ttlMs?: number;
    }>;
}

export function computeALMessage<Resource>(input: ComputeALMessageInput<Resource>): ALMessage {
    const expiresAtMs = input.options?.ttlMs !== undefined
        ? input.facts.nowEpochMs + input.options.ttlMs
        : undefined;
    return {
        id: {
            v: 2,
            msgId: input.facts.msgId,
            ts: input.facts.nowEpochMs,
            senderId: input.senderId
        },
        route: input.route,
        constraints: expiresAtMs !== undefined ? { expiresAtMs } : undefined,
        qos: input.options?.qos,
        payload: {
            typeId: input.typeId,
            contentType: 'application/json',
            resource: JSON.stringify(input.resource)
        },
        audit: {
            createdBy: input.senderId,
            createdTs: input.facts.nowEpochMs
        }
    };
}

export function computeALUnicastMessage<Resource>(
    input: ComputeALMessageInput<Resource> & Readonly<{ toPeerId: string; }>
): ALMessage {
    return {
        ...computeALMessage(input),
        targets: { mode: 'unicast', toPeerId: input.toPeerId }
    };
}
