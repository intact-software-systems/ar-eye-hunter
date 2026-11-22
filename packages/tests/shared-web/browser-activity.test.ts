import { BrowserActivity } from '@shared-web/browser/browser-activity.ts';
import { expect, it, vi } from 'vitest';

it('wakes account views on a cached page return and releases the wakeup on disposal', () => {
    const page = new EventTarget();
    vi.stubGlobal('window', page);
    vi.stubGlobal('document', new EventTarget());
    try {
        const activity = new BrowserActivity();
        const changed = vi.fn();
        const stop = activity.onChange(changed);
        const show = (persisted: boolean) => page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted }));
        show(false);
        expect(changed).not.toHaveBeenCalled();
        show(true);
        expect(changed).toHaveBeenCalledTimes(1);
        stop();
        show(true);
        expect(changed).toHaveBeenCalledTimes(1);
    }
    finally {
        vi.unstubAllGlobals();
    }
});
