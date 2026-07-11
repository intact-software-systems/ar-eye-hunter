import { RECIPE_CONSOLE_NAVIGATION } from '../app/recipe-console-navigation.ts';
import type { RecipeConsoleView } from '../routing/url-state-contract.ts';
import { Icon } from '../ui/Icon.tsx';
import type { RecipeConsolePresentation } from './responsive-presentation.ts';
import styles from './RecipeConsoleShell.module.css';

export function PrimaryNavigation({
    currentView,
    presentation,
    onNavigate,
}: Readonly<{
    currentView: RecipeConsoleView;
    presentation: RecipeConsolePresentation['navigation'];
    onNavigate(view: RecipeConsoleView): void;
}>) {
    return (
        <nav
            aria-label="Recipe Console"
            className={styles.primaryNavigation}
            data-presentation={presentation}
            data-primary-navigation
        >
            {RECIPE_CONSOLE_NAVIGATION.map(item => (
                <button
                    aria-current={item.view === currentView ? 'page' : undefined}
                    className={styles.navigationItem}
                    key={item.view}
                    onClick={() => onNavigate(item.view)}
                    type="button"
                >
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                </button>
            ))}
        </nav>
    );
}
