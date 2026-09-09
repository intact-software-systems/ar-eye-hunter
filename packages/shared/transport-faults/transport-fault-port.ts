import {
    AL_CONTROL_ACK_TYPE_ID,
    AL_CONTROL_NACK_TYPE_ID,
    AL_CONTROL_REPAIR_TYPE_ID,
    isALControlTypeId
} from '../al-contracts/al-control.ts';
import type { ApiJsonObject } from '../api/api-json-value.ts';

export type TransportFaultCarrier = 'ws' | 'rtc';

export type TransportFaultDecision =
    | Readonly<{ kind: 'pass'; }>
    | Readonly<{ kind: 'drop'; faultId: string; }>
    | Readonly<{ kind: 'delay'; faultId: string; delayMs: number; }>;

export interface TransportFaultPort {
    decideSend(carrier: TransportFaultCarrier, serialized: string): TransportFaultDecision;
}

export interface TransportFaultMatch {
    readonly controlType: 'ack' | 'nack' | 'repair' | undefined;
    readonly typeId: string | undefined;
    readonly msgId: string | undefined;
}

export interface ScriptedTransportFault {
    readonly faultId: string;
    readonly carrier: TransportFaultCarrier;
    readonly match: TransportFaultMatch;
    readonly action: 'drop' | Readonly<{ delayMs: number; }>;
    readonly remaining: number;
}

export interface TransportFaultObservation {
    readonly faultId: string;
    readonly carrier: TransportFaultCarrier;
    readonly decision: 'drop' | 'delay';
}

export interface ScriptedTransportFaultPort extends TransportFaultPort {
    inject(fault: ScriptedTransportFault): void;
    clear(): void;
    getObservations(): readonly TransportFaultObservation[];
}

/**
 * Both carriers write `JSON.stringify(ALMessage)`, so these facts are read out of the AL envelope:
 * the typeId sits under `payload`, and a control payload's own identities are a JSON string in
 * `payload.resource`.
 */
interface SerializedFrameFacts {
    readonly typeId: string | undefined;
    readonly msgId: string | undefined;
    readonly referencedMsgId: string | undefined;
}

const CONTROL_TYPE_IDS = {
    ack: AL_CONTROL_ACK_TYPE_ID,
    nack: AL_CONTROL_NACK_TYPE_ID,
    repair: AL_CONTROL_REPAIR_TYPE_ID
} as const;

export function createPassThroughTransportFaultPort(): TransportFaultPort {
    return { decideSend: () => ({ kind: 'pass' }) };
}

export function createScriptedTransportFaultPort(): ScriptedTransportFaultPort {
    const faults = new Map<string, ScriptedTransportFault>();
    const observations: TransportFaultObservation[] = [];
    return {
        inject(fault) {
            faults.set(fault.faultId, fault);
        },
        clear() {
            faults.clear();
            observations.length = 0;
        },
        getObservations() {
            return [...observations];
        },
        decideSend(carrier, serialized) {
            const facts = toSerializedFrameFacts(serialized);
            if (facts === undefined) {
                return { kind: 'pass' };
            }
            for (const fault of faults.values()) {
                if (
                    fault.carrier !== carrier || fault.remaining <= 0 ||
                    !matchesFault(fault.match, facts)
                ) {
                    continue;
                }
                faults.set(fault.faultId, { ...fault, remaining: fault.remaining - 1 });
                if (fault.action === 'drop') {
                    observations.push({ faultId: fault.faultId, carrier, decision: 'drop' });
                    return { kind: 'drop', faultId: fault.faultId };
                }
                observations.push({ faultId: fault.faultId, carrier, decision: 'delay' });
                return { kind: 'delay', faultId: fault.faultId, delayMs: fault.action.delayMs };
            }
            return { kind: 'pass' };
        }
    };
}

function matchesFault(match: TransportFaultMatch, facts: SerializedFrameFacts): boolean {
    if (match.controlType !== undefined && facts.typeId !== CONTROL_TYPE_IDS[match.controlType]) {
        return false;
    }
    if (match.typeId !== undefined && facts.typeId !== match.typeId) {
        return false;
    }
    if (
        match.msgId !== undefined && facts.msgId !== match.msgId &&
        facts.referencedMsgId !== match.msgId
    ) {
        return false;
    }
    return true;
}

function toSerializedFrameFacts(serialized: string): SerializedFrameFacts | undefined {
    try {
        return decodeSerializedFrameFacts(JSON.parse(serialized));
    }
    catch {
        return undefined;
    }
}

function decodeSerializedFrameFacts(value: unknown): SerializedFrameFacts | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const id: ApiJsonObject = isRecord(value.id) ? value.id : {};
    const payload: ApiJsonObject = isRecord(value.payload) ? value.payload : {};
    const typeId = typeof payload.typeId === 'string' ? payload.typeId : undefined;
    return {
        typeId,
        msgId: typeof id.msgId === 'string' ? id.msgId : undefined,
        referencedMsgId: typeId !== undefined && isALControlTypeId(typeId)
            ? decodeReferencedMsgId(payload.resource)
            : undefined
    };
}

/** An ack references the original message as `ackedMsgId`; a nack or repair references it as `msgId`. */
function decodeReferencedMsgId(resource: unknown): string | undefined {
    if (typeof resource !== 'string') {
        return undefined;
    }
    try {
        const control = JSON.parse(resource);
        if (!isRecord(control)) {
            return undefined;
        }
        if (typeof control.ackedMsgId === 'string') {
            return control.ackedMsgId;
        }
        return typeof control.msgId === 'string' ? control.msgId : undefined;
    }
    catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is ApiJsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
