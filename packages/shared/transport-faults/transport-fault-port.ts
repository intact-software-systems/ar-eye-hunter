import {
    AL_CONTROL_ACK_TYPE_ID,
    AL_CONTROL_NACK_TYPE_ID,
    AL_CONTROL_REPAIR_TYPE_ID
} from '../al-contracts/al-control.ts';

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

interface SerializedFrameFacts {
    readonly typeId: string | undefined;
    readonly msgId: string | undefined;
    readonly ackedMsgId: string | undefined;
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
        match.msgId !== undefined && facts.msgId !== match.msgId && facts.ackedMsgId !== match.msgId
    ) {
        return false;
    }
    return true;
}

function toSerializedFrameFacts(serialized: string): SerializedFrameFacts | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(serialized);
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const id = typeof record.id === 'object' && record.id !== null
        ? record.id as Record<string, unknown>
        : {};
    const payload = typeof record.payload === 'object' && record.payload !== null
        ? record.payload as Record<string, unknown>
        : {};
    return {
        typeId: typeof record.typeId === 'string' ? record.typeId : undefined,
        msgId: typeof id.msgId === 'string' ? id.msgId : undefined,
        ackedMsgId: typeof payload.ackedMsgId === 'string' ? payload.ackedMsgId : undefined
    };
}
