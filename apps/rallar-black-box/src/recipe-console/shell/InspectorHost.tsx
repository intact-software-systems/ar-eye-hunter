import type { ReactNode } from 'react';
import { OverlaySheet } from '../ui/OverlaySheet.tsx';
import type { RecipeConsolePresentation } from './responsive-presentation.ts';

export function InspectorHost({
    mode,
    open,
    onClose,
    restoreFocusTo,
    restoreFocusFallbacks,
    children,
}: Readonly<{
    mode: RecipeConsolePresentation['inspector'];
    open: boolean;
    onClose(): void;
    restoreFocusTo?: HTMLElement | null;
    restoreFocusFallbacks?(): readonly (HTMLElement | null | undefined)[];
    children: ReactNode;
}>) {
    return (
        <OverlaySheet
            label="Inspector"
            mode={mode}
            onClose={onClose}
            open={open}
            restoreFocusFallbacks={restoreFocusFallbacks}
            restoreFocusTo={restoreFocusTo}
        >
            {children}
        </OverlaySheet>
    );
}
