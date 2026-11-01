/** The page can refresh background views only while visible and online. */
export class BrowserActivity {
    isActive(): boolean {
        return document.visibilityState === 'visible' && navigator.onLine;
    }

    onChange(listener: () => void): () => void {
        document.addEventListener('visibilitychange', listener);
        window.addEventListener('online', listener);
        window.addEventListener('offline', listener);
        return () => {
            document.removeEventListener('visibilitychange', listener);
            window.removeEventListener('online', listener);
            window.removeEventListener('offline', listener);
        };
    }
}
