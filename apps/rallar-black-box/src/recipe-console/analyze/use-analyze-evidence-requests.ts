import { useCallback, useRef, useState } from 'react';
import type { AnalyzeEvidenceWindowProjection } from './analyze-worker-contract.ts';

type EvidenceRequest = Readonly<{
    fingerprint: string;
    kind: 'search' | 'window';
    requestId: number;
}>;

export function useAnalyzeEvidenceRequests() {
    const [window, setWindow] = useState<AnalyzeEvidenceWindowProjection>();
    const [windowFingerprint, setWindowFingerprint] = useState<string>();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string>();
    const requestRef = useRef<EvidenceRequest | undefined>(undefined);

    const begin = useCallback((
        input: Readonly<{
            fingerprint: string;
            kind: EvidenceRequest['kind'];
            send(): number | undefined;
        }>
    ): number | undefined => {
        const active = requestRef.current;
        if (
            active && (
                input.kind === 'window' ||
                active.fingerprint === input.fingerprint
            )
        ) {
            return undefined;
        }
        let requestId: number | undefined;
        try {
            requestId = input.send();
        }
        catch {
            requestRef.current = undefined;
            setPending(false);
            setError(requestFailureMessage(input.kind));
            return undefined;
        }
        if (requestId === undefined) {
            requestRef.current = undefined;
            setPending(false);
            setError(requestFailureMessage(input.kind));
            return undefined;
        }
        requestRef.current = {
            fingerprint: input.fingerprint,
            kind: input.kind,
            requestId
        };
        setPending(true);
        setError(undefined);
        return requestId;
    }, []);

    const complete = useCallback((
        input: Readonly<{
            kind: EvidenceRequest['kind'];
            requestId: number;
            window: AnalyzeEvidenceWindowProjection;
        }>
    ): boolean => {
        const active = requestRef.current;
        if (
            !active || active.kind !== input.kind ||
            active.requestId !== input.requestId
        ) {
            return false;
        }
        requestRef.current = undefined;
        setWindow(input.window);
        setWindowFingerprint(active.fingerprint);
        setPending(false);
        setError(undefined);
        return true;
    }, []);

    const acceptInitial = useCallback((
        initialWindow: AnalyzeEvidenceWindowProjection
    ) => {
        requestRef.current = undefined;
        setWindow(initialWindow);
        setWindowFingerprint(undefined);
        setPending(false);
        setError(undefined);
    }, []);

    const fail = useCallback((
        kind?: EvidenceRequest['kind'],
        requestId?: number
    ) => {
        const active = requestRef.current;
        if (
            !active || (kind && active.kind !== kind) ||
            (requestId !== undefined && active.requestId !== requestId)
        ) {
            return;
        }
        requestRef.current = undefined;
        setPending(false);
        setError(requestFailureMessage(active.kind));
    }, []);

    const clear = useCallback(() => {
        requestRef.current = undefined;
        setWindow(undefined);
        setWindowFingerprint(undefined);
        setPending(false);
        setError(undefined);
    }, []);

    return {
        window,
        windowFingerprint,
        pending,
        error,
        begin,
        complete,
        acceptInitial,
        fail,
        clear
    } as const;
}

function requestFailureMessage(kind: EvidenceRequest['kind']): string {
    return kind === 'window'
        ? 'The evidence window request failed. Try again.'
        : 'The evidence search request failed. Try again.';
}
