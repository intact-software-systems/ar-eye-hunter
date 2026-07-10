import type { ReactNode } from 'react';
import type { RecipeConsoleControlConnection } from
    '../control/ControlConnectionProvider.tsx';
import type { RecipeConsoleControlSelection } from
    '../control/control-selection-contract.ts';
import type { RecipeConsoleUrlState } from
    '../routing/url-state-contract.ts';

export type FleetWorkspaceProps = Readonly<{
    connection: RecipeConsoleControlConnection;
    selection: RecipeConsoleControlSelection;
    urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    replace(patch: Partial<RecipeConsoleUrlState>): void;
    onInspect(trigger: HTMLElement): void;
    onInspectorChange(content: ReactNode | undefined): void;
    onSelectionLabelChange(label: string | undefined): void;
}>;
