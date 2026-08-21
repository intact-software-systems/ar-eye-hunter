export async function loadBrowserRallarFacade() {
    const directFacade = typeof window === 'undefined'
        ? undefined
        : (window as Window & { __rallarDirectFacade?: unknown; })
            .__rallarDirectFacade;
    if (directFacade) {
        return directFacade as typeof import('@shared-web/browser/rallar.ts').rallar;
    }

    return (await import('@shared-web/browser/rallar.ts')).rallar;
}
