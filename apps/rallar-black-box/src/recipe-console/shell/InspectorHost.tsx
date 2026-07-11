import type { ReactNode } from 'react';
import { OverlaySheet } from '../ui/OverlaySheet.tsx';
import type { RecipeConsolePresentation } from './responsive-presentation.ts';

export function InspectorHost({
    mode,
    open,
    onClose,
    children,
}: Readonly<{
    mode: RecipeConsolePresentation['inspector'];
    open: boolean;
    onClose(): void;
    children: ReactNode;
}>) {
    return (
        <OverlaySheet label="Inspector" mode={mode} onClose={onClose} open={open}>
            {children}
        </OverlaySheet>
    );
}
