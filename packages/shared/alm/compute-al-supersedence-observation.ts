import type {
    ALSupersedenceInput,
    ALSupersedenceObservation,
    ALSupersedencePersistenceValue
} from '../al-contracts/al-runtime.ts';

export type ALLatestSupersedenceValue = Extract<ALSupersedencePersistenceValue, Readonly<{ kind: 'latest'; }>>;

export type ALReplacementSupersedenceValue = Extract<
    ALSupersedencePersistenceValue,
    Readonly<{ kind: 'replacement'; }>
>;

export interface ComputeALSupersedenceObservationInput {
    readonly supersedence: ALSupersedenceInput;
    readonly latest: ALLatestSupersedenceValue | undefined;
    readonly replacement: ALReplacementSupersedenceValue | undefined;
    readonly nowMs: number;
    readonly trackTtlMs: number;
}

export interface ALReplacementSupersedenceWrite {
    readonly msgId: string;
    readonly value: ALReplacementSupersedenceValue;
}

export interface ALSupersedenceAcceptance {
    readonly observation: ALSupersedenceObservation;
    readonly latestWrite?: ALLatestSupersedenceValue;
    readonly replacementWrites: readonly ALReplacementSupersedenceWrite[];
}

interface CompareALSupersedenceVersionInput {
    readonly leftSeq: number | undefined;
    readonly leftTs: number;
    readonly rightSeq: number | undefined;
    readonly rightTs: number;
}

export function computeALSupersedenceObservation(
    input: ComputeALSupersedenceObservationInput
): ALSupersedenceObservation {
    const supersedence = input.supersedence;
    if (!supersedence.key) {
        return { status: 'untracked' };
    }

    const replacement = toActiveALReplacementSupersedenceValue(input);
    if (replacement) {
        return {
            status: 'superseded',
            key: supersedence.key,
            latestMsgId: replacement.byMsgId,
            replacesMsgId: supersedence.replacesMsgId
        };
    }

    const latest = toActiveALLatestSupersedenceValue(input);
    if (!latest || latest.latestMsgId === supersedence.msgId) {
        return toCurrentALSupersedenceObservation(supersedence, latest?.latestMsgId);
    }
    if (supersedence.replacesMsgId && latest.latestMsgId === supersedence.replacesMsgId) {
        return {
            ...toCurrentALSupersedenceObservation(supersedence, latest.latestMsgId),
            status: 'replaces-current'
        };
    }

    return compareALSupersedenceVersion({
            leftSeq: supersedence.seq,
            leftTs: supersedence.ts,
            rightSeq: latest.latestSeq,
            rightTs: latest.latestTs
        }) >= 0
        ? {
            ...toCurrentALSupersedenceObservation(supersedence, latest.latestMsgId),
            status: 'replaces-current'
        }
        : {
            ...toCurrentALSupersedenceObservation(supersedence, latest.latestMsgId),
            status: 'superseded'
        };
}

export function acceptALSupersedenceObservation(
    input: ComputeALSupersedenceObservationInput
): ALSupersedenceAcceptance {
    const observation = computeALSupersedenceObservation(input);
    const supersedence = input.supersedence;
    if (!supersedence.key || observation.status === 'superseded') {
        return { observation, replacementWrites: [] };
    }

    const activeLatest = toActiveALLatestSupersedenceValue(input);
    return {
        observation: toCurrentALSupersedenceObservation(supersedence, supersedence.msgId),
        latestWrite: {
            kind: 'latest',
            latestMsgId: supersedence.msgId,
            latestSeq: supersedence.seq,
            latestTs: supersedence.ts,
            updatedAtMs: input.nowMs
        },
        replacementWrites: toALReplacementSupersedenceWrites(supersedence, activeLatest, input.nowMs)
    };
}

function toCurrentALSupersedenceObservation(
    supersedence: ALSupersedenceInput,
    latestMsgId: string | undefined
): ALSupersedenceObservation {
    return {
        status: 'current',
        key: supersedence.key,
        latestMsgId: latestMsgId ?? supersedence.msgId,
        replacesMsgId: supersedence.replacesMsgId
    };
}

function toALReplacementSupersedenceWrites(
    supersedence: ALSupersedenceInput,
    activeLatest: ALLatestSupersedenceValue | undefined,
    nowMs: number
): readonly ALReplacementSupersedenceWrite[] {
    const replacementWrites: ALReplacementSupersedenceWrite[] = [];
    if (activeLatest?.latestMsgId && activeLatest.latestMsgId !== supersedence.msgId) {
        replacementWrites.push(toALReplacementSupersedenceWrite(activeLatest.latestMsgId, supersedence.msgId, nowMs));
    }
    if (supersedence.replacesMsgId && supersedence.replacesMsgId !== supersedence.msgId) {
        replacementWrites.push(
            toALReplacementSupersedenceWrite(supersedence.replacesMsgId, supersedence.msgId, nowMs)
        );
    }

    return replacementWrites;
}

function toALReplacementSupersedenceWrite(
    msgId: string,
    byMsgId: string,
    nowMs: number
): ALReplacementSupersedenceWrite {
    return {
        msgId,
        value: {
            kind: 'replacement',
            byMsgId,
            updatedAtMs: nowMs
        }
    };
}

function toActiveALLatestSupersedenceValue(
    input: ComputeALSupersedenceObservationInput
): ALLatestSupersedenceValue | undefined {
    const latest = input.latest;
    return latest && latest.updatedAtMs + input.trackTtlMs > input.nowMs
        ? latest
        : undefined;
}

function toActiveALReplacementSupersedenceValue(
    input: ComputeALSupersedenceObservationInput
): ALReplacementSupersedenceValue | undefined {
    const replacement = input.replacement;
    return replacement && replacement.updatedAtMs + input.trackTtlMs > input.nowMs
        ? replacement
        : undefined;
}

function compareALSupersedenceVersion(
    input: CompareALSupersedenceVersionInput
): number {
    if (input.leftSeq !== undefined || input.rightSeq !== undefined) {
        return (input.leftSeq ?? Number.NEGATIVE_INFINITY) - (input.rightSeq ?? Number.NEGATIVE_INFINITY);
    }

    return input.leftTs - input.rightTs;
}
