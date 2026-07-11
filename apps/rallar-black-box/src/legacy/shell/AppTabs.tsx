import type { KeyboardEvent } from 'react';
import {
    APP_MODES,
    appTabsForMode,
    nextAppTab,
    type AppModeId,
    type AppTabId,
} from '../../app-tabs.ts';

export function AppTabs({
    activeMode,
    activeTab,
    onSelect,
}: {
    activeMode: AppModeId;
    activeTab: AppTabId;
    onSelect(tab: AppTabId): void;
}) {
    const handleKeyDown = (
        event: KeyboardEvent<HTMLButtonElement>,
        tab: AppTabId,
    ): void => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
            return;
        }

        event.preventDefault();
        onSelect(
            nextAppTab(tab, event.key === 'ArrowRight' ? 1 : -1, activeMode),
        );
    };
    const tabs = appTabsForMode(activeMode);
    const activeModeLabel =
        APP_MODES.find((mode) => mode.id === activeMode)?.label ?? 'Workspace';

    return (
        <nav className="app-tabs" aria-label="Rallar black-box sections">
            <div role="tablist" aria-label={`${activeModeLabel} tabs`}>
                {tabs.map((tab) => (
                    <button
                        key={tab.id}
                        id={`tab-${tab.id}`}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === tab.id}
                        aria-controls={`panel-${tab.id}`}
                        className={activeTab === tab.id ? 'selected' : ''}
                        tabIndex={activeTab === tab.id ? 0 : -1}
                        onClick={() => onSelect(tab.id)}
                        onKeyDown={(event) => handleKeyDown(event, tab.id)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
        </nav>
    );
}
