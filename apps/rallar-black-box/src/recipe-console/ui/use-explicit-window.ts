import { useCallback, useLayoutEffect, useState } from 'react';
import {
    createExplicitWindowState,
    deriveExplicitWindowModel,
    moveExplicitWindow,
    revealExplicitWindowIndex,
    type ExplicitWindowInput,
    type ExplicitWindowModel
} from './explicit-window-model.ts';
import { useExplicitWindowFocusRecovery } from './use-explicit-window-focus-recovery.ts';

export type ExplicitWindowController = Readonly<{
    model: ExplicitWindowModel;
    previous(): void;
    next(): void;
    revealIndex(index: number): void;
    reset(): void;
}>;

export function useExplicitWindow(
    input: ExplicitWindowInput
): ExplicitWindowController {
    const [state, setState] = useState(() => createExplicitWindowState(input.fingerprint, input.revision));
    const model = deriveExplicitWindowModel(input, state);
    useLayoutEffect(() => {
        if (
            state.fingerprint === model.fingerprint &&
            state.revision === model.revision &&
            state.startIndex === model.startIndex
        ) {
            return;
        }
        setState({
            fingerprint: model.fingerprint,
            ...(model.revision === undefined ? {} : { revision: model.revision }),
            startIndex: model.startIndex
        });
    }, [
        model.fingerprint,
        model.revision,
        model.startIndex,
        state.fingerprint,
        state.revision,
        state.startIndex
    ]);
    const move = useCallback((direction: 'previous' | 'next') => {
        setState((current) =>
            moveExplicitWindow(
                deriveExplicitWindowModel(input, current),
                direction
            )
        );
    }, [input.fingerprint, input.revision, input.total, input.windowSize]);
    const previous = useCallback(() => move('previous'), [move]);
    const next = useCallback(() => move('next'), [move]);
    const revealIndex = useCallback((index: number) => {
        setState((current) =>
            revealExplicitWindowIndex(
                deriveExplicitWindowModel(input, current),
                index
            )
        );
    }, [input.fingerprint, input.revision, input.total, input.windowSize]);
    const reset = useCallback(() => {
        setState(createExplicitWindowState(input.fingerprint, input.revision));
    }, [input.fingerprint, input.revision]);

    return { model, previous, next, revealIndex, reset };
}

export { useExplicitWindowFocusRecovery };
export type { ExplicitWindowFocusRecovery } from './use-explicit-window-focus-recovery.ts';
