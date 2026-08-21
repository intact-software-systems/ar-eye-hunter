import type { RecipeConsoleDiagnosticSeverity, RecipeConsoleTransport } from '../routing/url-state-contract.ts';
import { useExplicitWindow, useExplicitWindowFocusRecovery } from '../ui/use-explicit-window.ts';
import {
    createMonitorWindowFingerprint,
    monitorWindowBudget,
    type MonitorWindowSection
} from './monitor-window-contract.ts';

export type MonitorWindowController = ReturnType<typeof useMonitorWindow>;

export function useMonitorWindow(
    input: Readonly<{
        contextKey: string;
        section: MonitorWindowSection;
        total: number;
        diagnosticSeverity?: RecipeConsoleDiagnosticSeverity;
        transport?: RecipeConsoleTransport;
    }>
) {
    const fingerprint = createMonitorWindowFingerprint(input);
    const controller = useExplicitWindow({
        fingerprint,
        total: input.total,
        windowSize: monitorWindowBudget(input.section)
    });
    const focus = useExplicitWindowFocusRecovery(controller.model);
    return {
        ...controller,
        contentFocusProps: {
            ...focus.contentFocusProps,
            'data-monitor-window-owner': fingerprint
        },
        controlsFocusProps: {
            ...focus.contentFocusProps,
            'data-monitor-window-owner': fingerprint
        },
        focusFallbackRef: focus.fallbackFocusRef,
        owner: fingerprint
    } as const;
}
