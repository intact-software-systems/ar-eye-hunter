import type { ReactNode } from 'react';
import { OverlaySheet } from '../ui/OverlaySheet.tsx';
import type { RecipeConsolePresentation } from './responsive-presentation.ts';

export function InspectorHost({
    mode,
    open,
    onClose,
    restoreFocusTo,
    restoreFocusFallback,
    children,
}: Readonly<{
    mode: RecipeConsolePresentation['inspector'];
    open: boolean;
    onClose(): void;
    restoreFocusTo?: HTMLElement | null;
    restoreFocusFallback?(): HTMLElement | null;
    children: ReactNode;
}>) {
    return (
        <OverlaySheet
            label="Inspector"
            mode={mode}
            onClose={onClose}
            open={open}
            restoreFocusFallback={restoreFocusFallback}
            restoreFocusTo={restoreFocusTo}
        >
            {children}
        </OverlaySheet>
    );
}
