import type { RecipeConsoleControlSelection } from '../control/control-selection-contract.ts';
import type { RecipeConsoleUrlIssue, RecipeConsoleUrlState } from '../routing/url-state-contract.ts';

export type AdvancedWorkspaceProps = Readonly<{
    sourceSearch: string;
    selection: RecipeConsoleControlSelection;
    urlIssues: readonly RecipeConsoleUrlIssue[];
    urlState: RecipeConsoleUrlState;
}>;

export type AdvancedWorkspaceCategory =
    | 'direct-diagnostics'
    | 'workflow-fallbacks'
    | 'advanced-legacy';

export type AdvancedContextStatus =
    | 'ready'
    | 'absent'
    | 'invalid'
    | 'omitted'
    | 'unavailable';

export type AdvancedContextRow = Readonly<{
    field: string;
    label: string;
    status: AdvancedContextStatus;
    value?: string;
    message?: string;
}>;

export type AdvancedWorkspaceSurfaceLink = Readonly<{
    id: string;
    label: string;
    href: string;
    routeLabel: string;
}>;

export type AdvancedWorkspaceSection = Readonly<{
    id: AdvancedWorkspaceCategory;
    title: string;
    description: string;
    links: readonly AdvancedWorkspaceSurfaceLink[];
}>;

export type AdvancedWorkspaceModel = Readonly<{
    contextSourceLabel: string;
    contextRows: readonly AdvancedContextRow[];
    notices: readonly string[];
    sections: readonly AdvancedWorkspaceSection[];
}>;
