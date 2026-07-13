export type ExplicitWindowInput = Readonly<{
    fingerprint: string;
    total: number;
    windowSize: number;
}>;

export type ExplicitWindowState = Readonly<{
    fingerprint: string;
    startIndex: number;
}>;

export type ExplicitWindowModel = Readonly<{
    fingerprint: string;
    total: number;
    windowSize: number;
    startIndex: number;
    endIndexExclusive: number;
    displayStart: number;
    displayEnd: number;
    canPrevious: boolean;
    canNext: boolean;
}>;

export type ExplicitWindowDirection = 'previous' | 'next';

export function createExplicitWindowState(
    fingerprint: string,
): ExplicitWindowState {
    return { fingerprint, startIndex: 0 };
}

export function deriveExplicitWindowModel(
    input: ExplicitWindowInput,
    state: ExplicitWindowState,
): ExplicitWindowModel {
    const total = nonNegativeInteger(input.total);
    const windowSize = positiveInteger(input.windowSize);
    const lastStartIndex = total === 0
        ? 0
        : Math.floor((total - 1) / windowSize) * windowSize;
    const requestedStart = state.fingerprint === input.fingerprint
        ? Math.floor(nonNegativeInteger(state.startIndex) / windowSize) *
            windowSize
        : 0;
    const startIndex = Math.min(requestedStart, lastStartIndex);
    const endIndexExclusive = Math.min(startIndex + windowSize, total);

    return {
        fingerprint: input.fingerprint,
        total,
        windowSize,
        startIndex,
        endIndexExclusive,
        displayStart: total === 0 ? 0 : startIndex + 1,
        displayEnd: endIndexExclusive,
        canPrevious: startIndex > 0,
        canNext: endIndexExclusive < total,
    };
}

export function moveExplicitWindow(
    model: ExplicitWindowModel,
    direction: ExplicitWindowDirection,
): ExplicitWindowState {
    const startIndex = direction === 'previous'
        ? Math.max(0, model.startIndex - model.windowSize)
        : model.canNext
        ? model.endIndexExclusive
        : model.startIndex;
    return { fingerprint: model.fingerprint, startIndex };
}

function nonNegativeInteger(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function positiveInteger(value: number): number {
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}
