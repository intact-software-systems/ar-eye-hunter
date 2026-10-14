import { afterEach, beforeEach, vi } from 'vitest';

import type { BrowserPageLifecycleFlush } from '@shared-web/browser/al-runtime/browser-page-lifecycle-flush.ts';

class FakeDocument extends EventTarget {
    visibilityState: DocumentVisibilityState = 'visible';
}

/** A page's lifecycle events as a browser fires them: `visibilitychange` and `freeze` on the document, `pagehide` on the window. */
export class FakePageLifecycle implements BrowserPageLifecycleFlush.Page {
    readonly document = new FakeDocument();
    readonly window = new EventTarget();

    hide(): void {
        this.document.visibilityState = 'hidden';
        this.document.dispatchEvent(new Event('visibilitychange'));
    }

    show(): void {
        this.document.visibilityState = 'visible';
        this.document.dispatchEvent(new Event('visibilitychange'));
    }

    pagehide(): void {
        this.window.dispatchEvent(new Event('pagehide'));
    }

    freeze(): void {
        this.document.dispatchEvent(new Event('freeze'));
    }
}

/**
 * Node has no `document` or `window`, so a connect there registers no lifecycle listener: a file whose tests
 * drive the page installs a fake for each test, as the browser's globals.
 */
export function installFakePageLifecyclePerTest(): () => FakePageLifecycle {
    let page = new FakePageLifecycle();
    beforeEach(() => {
        page = new FakePageLifecycle();
        vi.stubGlobal('document', page.document);
        vi.stubGlobal('window', page.window);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });
    return () => page;
}
