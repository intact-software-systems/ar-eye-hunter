import {
    useEffect,
    useRef,
    useState,
    type KeyboardEvent,
} from 'react';

import {
    nextRovingNavigationIndex,
    type RovingNavigationKey,
} from '../app/navigation-keyboard.ts';
import { RECIPE_CONSOLE_NAVIGATION } from '../app/recipe-console-navigation.ts';
import type { RecipeConsoleView } from '../routing/url-state-contract.ts';
import { Icon } from '../ui/Icon.tsx';
import type { RecipeConsolePresentation } from './responsive-presentation.ts';
import styles from './RecipeConsoleShell.module.css';

function navigationIndexForView(view: RecipeConsoleView): number {
    const index = RECIPE_CONSOLE_NAVIGATION.findIndex(item => item.view === view);
    return index < 0 ? 0 : index;
}

function isRovingNavigationKey(key: string): key is RovingNavigationKey {
    return key === 'ArrowUp'
        || key === 'ArrowDown'
        || key === 'ArrowLeft'
        || key === 'ArrowRight'
        || key === 'Home'
        || key === 'End';
}

export function PrimaryNavigation({
    currentView,
    presentation,
    onNavigate,
}: Readonly<{
    currentView: RecipeConsoleView;
    presentation: RecipeConsolePresentation['navigation'];
    onNavigate(view: RecipeConsoleView): void;
}>) {
    const [activeIndex, setActiveIndex] = useState(
        () => navigationIndexForView(currentView),
    );
    const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

    useEffect(() => {
        setActiveIndex(navigationIndexForView(currentView));
    }, [currentView]);

    const activate = (index: number): void => {
        setActiveIndex(index);
        onNavigate(RECIPE_CONSOLE_NAVIGATION[index].view);
    };

    const handleKeyDown = (
        event: KeyboardEvent<HTMLButtonElement>,
        index: number,
    ): void => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate(index);
            return;
        }
        if (!isRovingNavigationKey(event.key)) {
            return;
        }

        event.preventDefault();
        const nextIndex = nextRovingNavigationIndex(
            index,
            event.key,
            RECIPE_CONSOLE_NAVIGATION.length,
        );
        setActiveIndex(nextIndex);
        itemRefs.current[nextIndex]?.focus();
    };

    return (
        <nav
            aria-label="Recipe Console"
            className={styles.primaryNavigation}
            data-presentation={presentation}
            data-primary-navigation
        >
            {RECIPE_CONSOLE_NAVIGATION.map((item, index) => (
                <button
                    aria-current={item.view === currentView ? 'page' : undefined}
                    className={styles.navigationItem}
                    key={item.view}
                    onClick={() => activate(index)}
                    onKeyDown={event => handleKeyDown(event, index)}
                    ref={button => {
                        itemRefs.current[index] = button;
                    }}
                    tabIndex={index === activeIndex ? 0 : -1}
                    type="button"
                >
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                </button>
            ))}
        </nav>
    );
}
