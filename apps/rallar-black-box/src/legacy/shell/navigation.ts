import {
    appModeForTab,
    appModeFromValue,
    appTabFromValue,
    appTabInMode,
    DEFAULT_APP_MODE_ID,
    DEFAULT_APP_TAB_ID,
    defaultAppTabForMode,
    runnerAdvancedSurfaceForTab,
    visibleAppTabForTab,
    type AppModeId,
    type AppTabId,
    type RunnerAdvancedSurfaceId
} from '../../app-tabs.ts';
import { readStoredAppMode, readStoredAppTab, writeStoredAppMode, writeStoredAppTab } from '../../ui-persistence.ts';
import { browserUiStorage } from './browser-ui-storage.ts';

export type AppNavigationState = Readonly<{
    mode: AppModeId;
    tab: AppTabId;
    advancedSurface?: RunnerAdvancedSurfaceId;
}>;

function advancedSurfaceFromValue(value: string | null | undefined): RunnerAdvancedSurfaceId | undefined {
    switch (value) {
        case 'manual':
        case 'workbench':
        case 'run-manager':
        case 'distributed':
        case 'shared-test':
            return value;
        default:
            return undefined;
    }
}

export function normalizeAppNavigation(
    input: Readonly<{
        mode?: AppModeId;
        tab: AppTabId;
        advancedSurface?: RunnerAdvancedSurfaceId;
    }>
): AppNavigationState {
    const visibleTab = visibleAppTabForTab(input.tab);
    const mode = input.mode && appTabInMode(visibleTab, input.mode)
        ? input.mode
        : appModeForTab(visibleTab);
    const advancedSurface = visibleTab === 'advanced'
        ? input.advancedSurface ?? runnerAdvancedSurfaceForTab(input.tab)
        : undefined;

    return {
        mode,
        tab: visibleTab,
        ...(advancedSurface ? { advancedSurface } : {})
    };
}

export function readInitialAppNavigation(): AppNavigationState {
    if (typeof window === 'undefined') {
        return {
            mode: DEFAULT_APP_MODE_ID,
            tab: DEFAULT_APP_TAB_ID
        };
    }

    const params = new URLSearchParams(window.location.search);
    const explicitModeValue = params.get('workspace') ?? params.get('appMode');
    const explicitMode = explicitModeValue
        ? appModeFromValue(explicitModeValue)
        : undefined;
    const explicitTab = params.get('tab');
    if (explicitTab) {
        const tab = appTabFromValue(explicitTab);
        const navigation = normalizeAppNavigation({
            mode: explicitMode,
            tab,
            advancedSurface: advancedSurfaceFromValue(
                params.get('advancedSurface') ?? params.get('advanced')
            )
        });
        writeStoredAppMode(browserUiStorage(), navigation.mode);
        writeStoredAppTab(browserUiStorage(), navigation.tab);
        return navigation;
    }

    const storedMode = readStoredAppMode(browserUiStorage());
    const mode = explicitMode ?? storedMode ?? DEFAULT_APP_MODE_ID;
    const storedTab = readStoredAppTab(browserUiStorage());
    const requestedTab = storedTab && appTabInMode(storedTab, mode)
        ? storedTab
        : defaultAppTabForMode(mode);
    const navigation = normalizeAppNavigation({
        mode,
        tab: requestedTab,
        advancedSurface: advancedSurfaceFromValue(
            params.get('advancedSurface') ?? params.get('advanced')
        )
    });

    writeStoredAppMode(browserUiStorage(), navigation.mode);
    writeStoredAppTab(browserUiStorage(), navigation.tab);
    return navigation;
}

export function writeAppNavigationToUrl(navigation: AppNavigationState): void {
    if (typeof window === 'undefined') {
        return;
    }

    writeStoredAppMode(browserUiStorage(), navigation.mode);
    writeStoredAppTab(browserUiStorage(), navigation.tab);
    const url = new URL(window.location.href);
    url.searchParams.set('workspace', navigation.mode);
    url.searchParams.set('tab', navigation.tab);
    if (navigation.advancedSurface) {
        url.searchParams.set('advancedSurface', navigation.advancedSurface);
    }
    else {
        url.searchParams.delete('advancedSurface');
        url.searchParams.delete('advanced');
    }
    window.history.replaceState(null, '', url);
}
