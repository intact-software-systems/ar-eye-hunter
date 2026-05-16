export const APP_TABS = [
    { id: 'manual-rallar', label: 'Manual Rallar' },
    { id: 'topology', label: 'Topology' },
    { id: 'rtc-diagnostics', label: 'RTC Diagnostics' },
    { id: 'local-workbench', label: 'Local Workbench' },
    { id: 'event-stream', label: 'Event Stream' },
    { id: 'rallar-server', label: 'Rallar Server' },
] as const;

export type AppTabId = typeof APP_TABS[number]['id'];

export const DEFAULT_APP_TAB_ID: AppTabId = 'manual-rallar';

const TAB_ALIASES: Readonly<Record<string, AppTabId>> = {
    manual: 'manual-rallar',
    rallar: 'manual-rallar',
    rtc: 'rtc-diagnostics',
    diagnostics: 'rtc-diagnostics',
    workbench: 'local-workbench',
    local: 'local-workbench',
    events: 'event-stream',
    event: 'event-stream',
    server: 'rallar-server',
};

export function appTabFromValue(value: string | null | undefined): AppTabId {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) {
        return DEFAULT_APP_TAB_ID;
    }

    const tab = APP_TABS.find(entry => entry.id === normalized);
    if (tab) {
        return tab.id;
    }

    return TAB_ALIASES[normalized] ?? DEFAULT_APP_TAB_ID;
}

export function nextAppTab(current: AppTabId, direction: -1 | 1): AppTabId {
    const currentIndex = APP_TABS.findIndex(entry => entry.id === current);
    const startIndex = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = (startIndex + direction + APP_TABS.length) % APP_TABS.length;
    return APP_TABS[nextIndex].id;
}
