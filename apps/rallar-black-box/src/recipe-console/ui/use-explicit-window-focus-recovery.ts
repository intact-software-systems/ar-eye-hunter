import {
    useCallback,
    useLayoutEffect,
    useMemo,
    useRef,
    type FocusEventHandler,
    type MouseEventHandler,
    type RefObject
} from 'react';
import type { ExplicitWindowModel } from './explicit-window-model.ts';

export type ExplicitWindowFocusRecovery = Readonly<{
    fallbackFocusRef: RefObject<HTMLSpanElement | null>;
    contentFocusProps: Readonly<{
        onBlurCapture: FocusEventHandler<HTMLElement>;
        onClick: MouseEventHandler<HTMLElement>;
        onFocusCapture: FocusEventHandler<HTMLElement>;
    }>;
}>;

export function useExplicitWindowFocusRecovery(
    model: ExplicitWindowModel
): ExplicitWindowFocusRecovery {
    const fallbackFocusRef = useRef<HTMLSpanElement>(null);
    const focusedRef = useRef<HTMLElement | undefined>(undefined);
    const recover = useCallback(() => {
        fallbackFocusRef.current?.focus({ preventScroll: true });
        focusedRef.current = undefined;
    }, []);
    const onFocusCapture = useCallback<FocusEventHandler<HTMLElement>>((event) => {
        if (event.target instanceof HTMLElement) {
            focusedRef.current = event.target;
        }
    }, []);
    const onBlurCapture = useCallback<FocusEventHandler<HTMLElement>>((event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) {
            return;
        }
        if (validExternalFocusTarget(next)) {
            focusedRef.current = undefined;
            return;
        }
        const target = event.target;
        if (!(target instanceof HTMLElement) || !unavailable(target)) {
            focusedRef.current = undefined;
        }
    }, []);
    const onClick = useCallback<MouseEventHandler<HTMLElement>>((event) => {
        const target = event.target instanceof Element
            ? event.target.closest<HTMLButtonElement>(
                'button[data-explicit-window-direction]'
            )
            : null;
        if (
            !target || !event.currentTarget.contains(target) || target.disabled ||
            target.getAttribute('aria-disabled') === 'true'
        ) {
            return;
        }
        const direction = target.dataset.explicitWindowDirection;
        const boundary = direction === 'next'
            ? model.canNext && model.endIndexExclusive + model.windowSize >= model.total
            : direction === 'previous'
            ? model.canPrevious && model.startIndex <= model.windowSize
            : false;
        if (boundary) {
            recover();
        }
    }, [
        model.canNext,
        model.canPrevious,
        model.endIndexExclusive,
        model.startIndex,
        model.total,
        model.windowSize,
        recover
    ]);
    useLayoutEffect(() => {
        if (focusedRef.current && unavailable(focusedRef.current)) {
            recover();
        }
    });
    const contentFocusProps = useMemo(() => ({
        onBlurCapture,
        onClick,
        onFocusCapture
    }), [onBlurCapture, onClick, onFocusCapture]);
    return { fallbackFocusRef, contentFocusProps };
}

function unavailable(element: HTMLElement): boolean {
    return !element.isConnected || element.matches(':disabled');
}

function validExternalFocusTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && target !== document.body &&
        !unavailable(target) && (target.tabIndex >= 0 ||
            target.hasAttribute('tabindex') || target.isContentEditable);
}
