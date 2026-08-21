import { useExplicitWindow, useExplicitWindowFocusRecovery } from '../ui/use-explicit-window.ts';
import { createFleetWindowFingerprint, fleetWindowBudget, type FleetWindowSection } from './fleet-window-contract.ts';

export type FleetWindowController = ReturnType<typeof useFleetWindow>;

export function useFleetWindow(
    input: Readonly<{
        contextKey: string;
        revision?: object;
        section: FleetWindowSection;
        total: number;
    }>
) {
    const owner = createFleetWindowFingerprint(input);
    const controller = useExplicitWindow({
        fingerprint: owner,
        revision: input.revision,
        total: input.total,
        windowSize: fleetWindowBudget(input.section)
    });
    const focus = useExplicitWindowFocusRecovery(controller.model);
    return {
        ...controller,
        contentFocusProps: {
            ...focus.contentFocusProps,
            'data-fleet-window-owner': owner
        },
        controlsFocusProps: {
            ...focus.contentFocusProps,
            'data-fleet-window-owner': owner
        },
        focusFallbackRef: focus.fallbackFocusRef,
        owner
    } as const;
}
