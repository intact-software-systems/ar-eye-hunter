import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { APP_MODES, appTabsForMode, nextAppTab, type AppModeId, type AppTabId } from '../../app-tabs.ts';

export function AppTabs({
    activeMode,
    activeTab,
    onSelect
}: {
    activeMode: AppModeId;
    activeTab: AppTabId;
    onSelect(tab: AppTabId): void;
}) {
    const tabs = appTabsForMode(activeMode);
    const previousActiveTabRef = useRef(activeTab);
    useLayoutEffect(() => {
        const changed = previousActiveTabRef.current !== activeTab;
        previousActiveTabRef.current = activeTab;
        const target = document.getElementById(`tab-${activeTab}`);
        const activeElement = target?.ownerDocument.activeElement;
        const focusUnavailable = !activeElement?.isConnected ||
            Boolean(activeElement?.closest('[hidden], [inert]'));
        if (changed && (focusUnavailable || activeElement === target?.ownerDocument.body)) {
            target?.focus({ preventScroll: true });
        }
    }, [activeTab]);
    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: AppTabId): void => {
        const targetTab = event.key === 'ArrowRight'
            ? nextAppTab(tab, 1, activeMode)
            : event.key === 'ArrowLeft'
            ? nextAppTab(tab, -1, activeMode)
            : event.key === 'Home'
            ? tabs[0]?.id
            : event.key === 'End'
            ? tabs[tabs.length - 1]?.id
            : undefined;
        if (!targetTab) {
            return;
        }

        event.preventDefault();
        onSelect(targetTab);
        event.currentTarget.ownerDocument.getElementById(`tab-${targetTab}`)
            ?.focus({ preventScroll: true });
    };
    const activeModeLabel = APP_MODES.find((mode) => mode.id === activeMode)?.label ??
        'Workspace';
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
