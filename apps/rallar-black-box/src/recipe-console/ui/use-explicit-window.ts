import {
    useCallback,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type FocusEventHandler,
    type RefObject,
} from 'react';
import {
    createExplicitWindowState,
    deriveExplicitWindowModel,
    moveExplicitWindow,
    type ExplicitWindowInput,
    type ExplicitWindowModel,
} from './explicit-window-model.ts';

export type ExplicitWindowController = Readonly<{
    model: ExplicitWindowModel;
    previous(): void;
    next(): void;
    reset(): void;
}>;

export type ExplicitWindowFocusRecovery = Readonly<{
    fallbackFocusRef: RefObject<HTMLSpanElement | null>;
    contentFocusProps: Readonly<{
        onFocusCapture: FocusEventHandler<HTMLElement>;
        onBlurCapture: FocusEventHandler<HTMLElement>;
    }>;
}>;

export function useExplicitWindow(
    input: ExplicitWindowInput,
): ExplicitWindowController {
    const [state, setState] = useState(() =>
        createExplicitWindowState(input.fingerprint)
    );
    const model = deriveExplicitWindowModel(input, state);
    useLayoutEffect(() => {
        if (
            state.fingerprint === model.fingerprint &&
            state.startIndex === model.startIndex
        ) return;
        setState({
            fingerprint: model.fingerprint,
            startIndex: model.startIndex,
        });
    }, [model.fingerprint, model.startIndex, state.fingerprint, state.startIndex]);
    const move = useCallback((direction: 'previous' | 'next') => {
        setState(current => moveExplicitWindow(
            deriveExplicitWindowModel(input, current),
            direction,
        ));
    }, [input.fingerprint, input.total, input.windowSize]);
    const previous = useCallback(() => move('previous'), [move]);
    const next = useCallback(() => move('next'), [move]);
    const reset = useCallback(() => {
        setState(createExplicitWindowState(input.fingerprint));
    }, [input.fingerprint]);

    return { model, previous, next, reset };
}

export function useExplicitWindowFocusRecovery(
    model: ExplicitWindowModel,
): ExplicitWindowFocusRecovery {
    const fallbackFocusRef = useRef<HTMLSpanElement>(null);
    const focusedContentElementRef = useRef<HTMLElement | undefined>(undefined);
    const onFocusCapture = useCallback<FocusEventHandler<HTMLElement>>(event => {
        if (event.target instanceof HTMLElement) {
            focusedContentElementRef.current = event.target;
        }
    }, []);
    const onBlurCapture = useCallback<FocusEventHandler<HTMLElement>>(event => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        if (!(event.target instanceof HTMLElement) || event.target.isConnected) {
            focusedContentElementRef.current = undefined;
        }
    }, []);

    useLayoutEffect(() => {
        const previous = focusedContentElementRef.current;
        if (!previous || previous.isConnected) return;
        fallbackFocusRef.current?.focus();
        focusedContentElementRef.current = undefined;
    }, [
        model.fingerprint,
        model.startIndex,
        model.endIndexExclusive,
        model.total,
    ]);

    const contentFocusProps = useMemo(() => ({
        onFocusCapture,
        onBlurCapture,
    }), [onBlurCapture, onFocusCapture]);
    return { fallbackFocusRef, contentFocusProps };
}
