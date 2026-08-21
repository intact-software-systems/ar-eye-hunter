import { useMemo } from 'react';
import { useExplicitWindow, useExplicitWindowFocusRecovery } from '../ui/use-explicit-window.ts';
import {
    createExecuteWindowFingerprint,
    executeWindowBudget,
    type ExecuteWindowSection
} from './execute-window-contract.ts';

export function useExecuteWindow(
    input: Readonly<{
        contextKey: string;
        revisionKey: string;
        section: ExecuteWindowSection;
        total: number;
    }>
) {
    const revision = useMemo(
        () => ({ key: input.revisionKey }),
        [input.revisionKey]
    );
    const controller = useExplicitWindow({
        fingerprint: createExecuteWindowFingerprint(input),
        revision,
        total: input.total,
        windowSize: executeWindowBudget(input.section)
    });
    const focus = useExplicitWindowFocusRecovery(controller.model);
    return {
        ...controller,
        contentFocusProps: focus.contentFocusProps,
        controlsFocusProps: focus.contentFocusProps,
        focusFallbackRef: focus.fallbackFocusRef
    } as const;
}
