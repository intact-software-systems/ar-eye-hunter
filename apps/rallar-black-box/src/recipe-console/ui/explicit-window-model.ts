export type ExplicitWindowInput = Readonly<{
    fingerprint: string;
    revision?: object;
    total: number;
    windowSize: number;
}>;

export type ExplicitWindowState = Readonly<{
    fingerprint: string;
    revision?: object;
    startIndex: number;
}>;

export type ExplicitWindowModel = Readonly<{
    fingerprint: string;
    revision?: object;
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
    revision?: object,
): ExplicitWindowState {
    return windowState(fingerprint, revision, 0);
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
    const requestedStart = state.fingerprint === input.fingerprint &&
            state.revision === input.revision
        ? Math.floor(nonNegativeInteger(state.startIndex) / windowSize) *
            windowSize
        : 0;
    const startIndex = Math.min(requestedStart, lastStartIndex);
    const endIndexExclusive = Math.min(startIndex + windowSize, total);

    return {
        fingerprint: input.fingerprint,
        ...(input.revision === undefined ? {} : { revision: input.revision }),
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
    return windowState(model.fingerprint, model.revision, startIndex);
}

export function revealExplicitWindowIndex(
    model: ExplicitWindowModel,
    index: number,
): ExplicitWindowState {
    const lastIndex = Math.max(0, model.total - 1);
    const boundedIndex = Math.min(nonNegativeInteger(index), lastIndex);
    const startIndex = Math.floor(boundedIndex / model.windowSize) * model.windowSize;
    return windowState(model.fingerprint, model.revision, startIndex);
}

function nonNegativeInteger(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function positiveInteger(value: number): number {
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function windowState(
    fingerprint: string,
    revision: object | undefined,
    startIndex: number,
): ExplicitWindowState {
    return {
        fingerprint,
        ...(revision === undefined ? {} : { revision }),
        startIndex,
    };
}
