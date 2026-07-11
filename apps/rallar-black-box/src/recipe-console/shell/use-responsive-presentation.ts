import { useMemo, useSyncExternalStore } from 'react';
import { resolveRecipeConsolePresentation } from './responsive-presentation.ts';

const subscribers = new Set<() => void>();
let orientationQuery: MediaQueryList | undefined;

function notifySubscribers(): void {
    for (const subscriber of subscribers) subscriber();
}

function subscribe(subscriber: () => void): () => void {
    subscribers.add(subscriber);
    if (subscribers.size === 1) {
        orientationQuery = window.matchMedia('(orientation: landscape)');
        window.addEventListener('resize', notifySubscribers);
        orientationQuery.addEventListener('change', notifySubscribers);
    }
    return () => {
        subscribers.delete(subscriber);
        if (subscribers.size === 0) {
            window.removeEventListener('resize', notifySubscribers);
            orientationQuery?.removeEventListener('change', notifySubscribers);
            orientationQuery = undefined;
        }
    };
}

function viewportSnapshot(): string {
    return `${window.innerWidth}:${window.innerHeight}`;
}

export function useRecipeConsolePresentation() {
    const snapshot = useSyncExternalStore(subscribe, viewportSnapshot, () => '1440:900');
    return useMemo(() => {
        const [width, height] = snapshot.split(':').map(Number);
        return resolveRecipeConsolePresentation(width, height);
    }, [snapshot]);
}
