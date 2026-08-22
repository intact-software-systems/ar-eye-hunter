import { useMemo, useSyncExternalStore } from 'react';
import { resolveRecipeConsolePresentation } from './responsive-presentation.ts';

type ViewportListener = () => void;

export type ViewportSubscriptionPort = Readonly<{
    width(): number;
    height(): number;
    addResizeListener(listener: ViewportListener): void;
    removeResizeListener(listener: ViewportListener): void;
    addOrientationListener(listener: ViewportListener): void;
    removeOrientationListener(listener: ViewportListener): void;
}>;

export function createViewportSubscriptionStore(port: ViewportSubscriptionPort) {
    const subscribers = new Set<ViewportListener>();
    const notify = () => subscribers.forEach((subscriber) => subscriber());
    return {
        snapshot: () => `${port.width()}:${port.height()}`,
        subscribe(subscriber: ViewportListener): () => void {
            subscribers.add(subscriber);
            if (subscribers.size === 1) {
                port.addResizeListener(notify);
                port.addOrientationListener(notify);
            }
            return () => {
                subscribers.delete(subscriber);
                if (subscribers.size === 0) {
                    port.removeResizeListener(notify);
                    port.removeOrientationListener(notify);
                }
            };
        }
    } as const;
}

let browserStore: ReturnType<typeof createViewportSubscriptionStore> | undefined;

function getBrowserStore() {
    if (browserStore) {
        return browserStore;
    }
    const orientation = window.matchMedia('(orientation: landscape)');
    browserStore = createViewportSubscriptionStore({
        width: () => window.innerWidth,
        height: () => window.innerHeight,
        addResizeListener: (listener) => window.addEventListener('resize', listener),
        removeResizeListener: (listener) => window.removeEventListener('resize', listener),
        addOrientationListener: (listener) => orientation.addEventListener('change', listener),
        removeOrientationListener: (listener) => orientation.removeEventListener('change', listener)
    });
    return browserStore;
}

export function useRecipeConsolePresentation() {
    const store = getBrowserStore();
    const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, () => '1440:900');
    return useMemo(() => {
        const [width, height] = snapshot.split(':').map(Number);
        return resolveRecipeConsolePresentation(width, height);
    }, [snapshot]);
}
