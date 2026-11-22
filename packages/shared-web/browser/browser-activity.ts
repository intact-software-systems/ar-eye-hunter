/** The page can refresh background views only while visible and online. */
export class BrowserActivity {
    isActive(): boolean {
        return document.visibilityState === 'visible' && navigator.onLine;
    }

    onChange(listener: () => void): () => void {
        const restored = (event: PageTransitionEvent) => {
            if (event.persisted) listener();
        };
        window.addEventListener('pageshow', restored);
        document.addEventListener('visibilitychange', listener);
        window.addEventListener('online', listener);
        window.addEventListener('offline', listener);
        return () => {
            window.removeEventListener('pageshow', restored);
            document.removeEventListener('visibilitychange', listener);
            window.removeEventListener('online', listener);
            window.removeEventListener('offline', listener);
        };
    }
}
