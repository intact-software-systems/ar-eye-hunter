import {
    useExplicitWindow,
    useExplicitWindowFocusRecovery,
} from '../ui/use-explicit-window.ts';
import { TUNE_WINDOW_BUDGETS } from './tune-window-contract.ts';

export function useTuneBlockedKnobWindow(
    revision: object,
    total: number,
) {
    const controller = useExplicitWindow({
        fingerprint: 'tune-blocked-knobs-v1',
        revision,
        total,
        windowSize: TUNE_WINDOW_BUDGETS.blockedKnobs,
    });
    const focus = useExplicitWindowFocusRecovery(controller.model);
    return {
        ...controller,
        contentFocusProps: focus.contentFocusProps,
        focusFallbackRef: focus.fallbackFocusRef,
    } as const;
}
