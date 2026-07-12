import {
    useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import type { RecipeConsoleControlRetentionCapability } from
    '../control/control-api.ts';
import type { RecipeConsoleControlRetentionApi } from
    '../control/control-retention-api.ts';
import type {
    ControlRetentionConfirmation,
    ControlRetentionPreview,
} from '../control/control-retention-validation.ts';
import {
    freezeRetentionCleanupState,
    freezeRetentionConfirmation,
    invalidatedRetentionCleanupState,
    isRetentionAbortError,
    isRetentionConflict,
    retentionErrorMessage,
    sanitizeRetentionCleanupPreview,
    staleRetentionCleanupPreview,
    unavailableRetentionCleanupState,
    type RetentionCleanupController,
    type RetentionCleanupPreview,
    type RetentionCleanupState,
} from './retention-cleanup-model.ts';
export type {
    RetentionCleanupController,
    RetentionCleanupPreview,
    RetentionCleanupState,
    RetentionCleanupStatus,
} from './retention-cleanup-model.ts';

type StateEnvelope = Readonly<{
    capability?: RecipeConsoleControlRetentionCapability;
    generation?: symbol;
    signal?: AbortSignal;
    state: RetentionCleanupState;
}>;

type ActiveOperation = Readonly<{
    id: number;
    context: number;
    controller: AbortController;
}>;

const IDLE = freezeRetentionCleanupState({ status: 'idle' });

export function useRetentionCleanup(input: Readonly<{
    capability?: RecipeConsoleControlRetentionCapability;
    unavailableReason?: string;
}>): RetentionCleanupController {
    const generation = input.capability?.generation;
    const signal = input.capability?.signal;
    const [envelope, setEnvelope] = useState<StateEnvelope>(() => ({
        capability: input.capability,
        generation,
        signal,
        state: input.capability
            ? IDLE
            : unavailableRetentionCleanupState(input.unavailableReason),
    }));
    const mountedRef = useRef(true);
    const contextRef = useRef(0);
    const operationIdRef = useRef(0);
    const operationRef = useRef<ActiveOperation | undefined>(undefined);
    const busyRef = useRef(false);
    const rawPreviewRef = useRef<ControlRetentionPreview | undefined>(undefined);
    const apiRef = useRef<Readonly<{
        context: number;
        api: RecipeConsoleControlRetentionApi;
    }> | undefined>(undefined);

    const contextMatches = envelope.capability === input.capability &&
        envelope.generation === generation &&
        envelope.signal === signal && Boolean(input.capability) &&
        signal?.aborted !== true;
    const state = contextMatches
        ? envelope.state
        : invalidatedRetentionCleanupState(
            envelope.state,
            input.unavailableReason,
        );

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            operationRef.current?.controller.abort();
            rawPreviewRef.current = undefined;
            apiRef.current = undefined;
        };
    }, []);

    useLayoutEffect(() => {
        const context = ++contextRef.current;
        operationRef.current?.controller.abort();
        operationRef.current = undefined;
        busyRef.current = false;
        rawPreviewRef.current = undefined;
        apiRef.current = undefined;
        setEnvelope(previous => previous.capability === input.capability &&
                previous.generation === generation &&
                previous.signal === signal
            ? previous
            : {
                capability: input.capability,
                generation,
                signal,
                state: invalidatedRetentionCleanupState(
                    previous.state,
                    input.unavailableReason,
                ),
            });
        const onAbort = () => {
            if (!mountedRef.current || contextRef.current !== context) return;
            ++contextRef.current;
            operationRef.current?.controller.abort();
            operationRef.current = undefined;
            busyRef.current = false;
            rawPreviewRef.current = undefined;
            apiRef.current = undefined;
            setEnvelope(previous => ({
                ...previous,
                state: invalidatedRetentionCleanupState(
                    previous.state,
                    input.unavailableReason,
                ),
            }));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        return () => {
            signal?.removeEventListener('abort', onAbort);
            if (contextRef.current === context) ++contextRef.current;
            operationRef.current?.controller.abort();
            operationRef.current = undefined;
            busyRef.current = false;
            rawPreviewRef.current = undefined;
            apiRef.current = undefined;
        };
    }, [generation, input.capability, input.unavailableReason, signal]);

    const setCurrentState = useCallback((
        capability: RecipeConsoleControlRetentionCapability,
        next: RetentionCleanupState,
    ): void => {
        if (!mountedRef.current || capability.signal.aborted) return;
        setEnvelope(previous => previous.capability === capability &&
                previous.generation === capability.generation &&
                previous.signal === capability.signal
            ? { ...previous, state: next }
            : previous);
    }, []);

    const preview = useCallback(async (): Promise<void> => {
        const capability = input.capability;
        if (!capability || capability.signal.aborted || busyRef.current) return;
        const context = contextRef.current;
        const operation = beginOperation(context, operationIdRef, operationRef);
        busyRef.current = true;
        rawPreviewRef.current = undefined;
        setCurrentState(capability, freezeRetentionCleanupState({
            status: 'previewing',
        }));
        try {
            const api = await capability.load();
            if (!isCurrent(operation, contextRef, operationRef, capability)) return;
            apiRef.current = { context, api };
            const raw = await api.preview({ signal: operation.controller.signal });
            if (!isCurrent(operation, contextRef, operationRef, capability)) return;
            const sanitized = sanitizeRetentionCleanupPreview(raw);
            rawPreviewRef.current = raw;
            setCurrentState(capability, freezeRetentionCleanupState({
                status: 'preview-ready',
                preview: sanitized,
            }));
        } catch (error) {
            if (!isCurrent(operation, contextRef, operationRef, capability)) return;
            rawPreviewRef.current = undefined;
            setCurrentState(capability, isRetentionAbortError(error)
                ? IDLE
                : freezeRetentionCleanupState({
                    status: 'error',
                    message: retentionErrorMessage(error),
                }));
        } finally {
            finishOperation(operation, operationRef, busyRef);
        }
    }, [input.capability, setCurrentState]);

    const confirm = useCallback(async (
        afterConfirmed?: (
            confirmation: ControlRetentionConfirmation,
            preview: RetentionCleanupPreview,
            signal: AbortSignal,
        ) => void | Promise<void>,
    ): Promise<void> => {
        const capability = input.capability;
        const raw = rawPreviewRef.current;
        const sanitized = envelope.state.preview;
        const loaded = apiRef.current;
        if (
            !capability || capability.signal.aborted || busyRef.current ||
            !raw || !sanitized?.current || sanitized.maxRuns === 0 ||
            sanitized.candidates.length === 0 ||
            loaded?.context !== contextRef.current
        ) return;
        const context = contextRef.current;
        const operation = beginOperation(context, operationIdRef, operationRef);
        busyRef.current = true;
        rawPreviewRef.current = undefined;
        setCurrentState(capability, freezeRetentionCleanupState({
            status: 'confirming',
            preview: sanitized,
        }));
        try {
            const result = await loaded.api.confirm({
                preview: raw,
                signal: operation.controller.signal,
            });
            if (!isCurrent(operation, contextRef, operationRef, capability)) return;
            await afterConfirmed?.(result, sanitized, operation.controller.signal);
            if (!isCurrent(operation, contextRef, operationRef, capability)) return;
            setCurrentState(capability, freezeRetentionCleanupState({
                status: 'succeeded',
                preview: staleRetentionCleanupPreview(sanitized),
                confirmation: freezeRetentionConfirmation(result),
            }));
        } catch (error) {
            if (!isCurrent(operation, contextRef, operationRef, capability)) return;
            const preview = staleRetentionCleanupPreview(sanitized);
            setCurrentState(capability, isRetentionAbortError(error)
                ? freezeRetentionCleanupState({ status: 'idle', preview })
                : freezeRetentionCleanupState({
                    status: isRetentionConflict(error) ? 'drift' : 'error',
                    preview,
                    message: retentionErrorMessage(error),
                }));
        } finally {
            finishOperation(operation, operationRef, busyRef);
        }
    }, [envelope.state.preview, input.capability, setCurrentState]);

    const busy = state.status === 'previewing' || state.status === 'confirming';
    const canPreview = Boolean(input.capability && !signal?.aborted && !busy);
    const canConfirm = Boolean(
        contextMatches && state.status === 'preview-ready' &&
        state.preview?.current && state.preview.maxRuns > 0 &&
        state.preview.candidates.length > 0 && rawPreviewRef.current && !busy,
    );
    return useMemo(() => Object.freeze({
        state,
        canPreview,
        canConfirm,
        busy,
        preview,
        confirm,
    }), [busy, canConfirm, canPreview, confirm, preview, state]);
}

function beginOperation(
    context: number,
    idRef: { current: number },
    operationRef: { current?: ActiveOperation },
): ActiveOperation {
    operationRef.current?.controller.abort();
    const operation = {
        id: ++idRef.current,
        context,
        controller: new AbortController(),
    };
    operationRef.current = operation;
    return operation;
}

function isCurrent(
    operation: ActiveOperation,
    contextRef: { current: number },
    operationRef: { current?: ActiveOperation },
    capability: RecipeConsoleControlRetentionCapability,
): boolean {
    return operationRef.current?.id === operation.id &&
        contextRef.current === operation.context &&
        !operation.controller.signal.aborted && !capability.signal.aborted;
}

function finishOperation(
    operation: ActiveOperation,
    operationRef: { current?: ActiveOperation },
    busyRef: { current: boolean },
): void {
    if (operationRef.current?.id !== operation.id) return;
    operationRef.current = undefined;
    busyRef.current = false;
}
