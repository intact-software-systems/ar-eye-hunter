import type { IconName } from '../ui/Icon.tsx';
import type { RecipeConsoleView } from '../routing/url-state-contract.ts';

export type RecipeConsoleNavigationItem = Readonly<{
    view: RecipeConsoleView;
    label: string;
    icon: IconName;
}>;

export const RECIPE_CONSOLE_NAVIGATION: readonly RecipeConsoleNavigationItem[] = [
    { view: 'execute', label: 'Execute', icon: 'play' },
    { view: 'monitor', label: 'Monitor', icon: 'pulse' },
    { view: 'analyze', label: 'Analyze', icon: 'search' },
    { view: 'tune', label: 'Tune', icon: 'sliders' },
    { view: 'fleet', label: 'Fleet', icon: 'globe' },
    { view: 'advanced', label: 'Advanced', icon: 'tools' },
] as const;
