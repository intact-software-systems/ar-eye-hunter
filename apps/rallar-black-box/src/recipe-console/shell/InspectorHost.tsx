import type { ReactNode } from 'react';
import { OverlaySheet } from '../ui/OverlaySheet.tsx';
import type { RecipeConsolePresentation } from './responsive-presentation.ts';

export function InspectorHost({
    mode,
    open,
    onClose,
    restoreFocusTo,
    children,
}: Readonly<{
    mode: RecipeConsolePresentation['inspector'];
    open: boolean;
    onClose(): void;
    restoreFocusTo?: HTMLElement | null;
    children: ReactNode;
}>) {
    return (
        <OverlaySheet
            label="Inspector"
            mode={mode}
            onClose={onClose}
            open={open}
            restoreFocusTo={restoreFocusTo}
        >
            {children}
        </OverlaySheet>
    );
}
