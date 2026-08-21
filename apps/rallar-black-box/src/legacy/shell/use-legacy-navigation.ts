import { useEffect, useState } from 'react';
import {
    appModeForTab,
    appTabInMode,
    defaultAppTabForMode,
    visibleAppTabForTab,
    type AppModeId,
    type AppTabId,
    type RunnerAdvancedSurfaceId
} from '../../app-tabs.ts';
import {
    normalizeAppNavigation,
    readInitialAppNavigation,
    writeAppNavigationToUrl,
    type AppNavigationState
} from './navigation.ts';

export function useLegacyNavigation() {
    const [navigation, setNavigation] = useState<AppNavigationState>(() => readInitialAppNavigation());
    const {
        mode: activeMode,
        tab: activeTab,
        advancedSurface: activeAdvancedSurface
    } = navigation;

    useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        const handlePopState = (): void => setNavigation(readInitialAppNavigation());
        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, []);

    const selectNavigation = (nextNavigation: AppNavigationState): void => {
        setNavigation(nextNavigation);
        writeAppNavigationToUrl(nextNavigation);
    };
    const selectTab = (
        tab: AppTabId,
        advancedSurface?: RunnerAdvancedSurfaceId
    ): void => {
        const visibleTab = visibleAppTabForTab(tab);
        const mode = appTabInMode(visibleTab, activeMode)
            ? activeMode
            : appModeForTab(visibleTab);
        selectNavigation(
            normalizeAppNavigation({
                mode,
                tab,
                advancedSurface
            })
        );
    };
    const selectMode = (mode: AppModeId): void => {
        selectNavigation(
            normalizeAppNavigation({
                mode,
                tab: appTabInMode(activeTab, mode)
                    ? activeTab
                    : defaultAppTabForMode(mode),
                advancedSurface: activeAdvancedSurface
            })
        );
    };

    return {
        activeMode,
        activeTab,
        activeAdvancedSurface,
        selectNavigation,
        selectTab,
        selectMode
    };
}
