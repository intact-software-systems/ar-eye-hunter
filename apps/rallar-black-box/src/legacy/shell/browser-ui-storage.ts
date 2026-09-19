import type { RallarBlackBoxUiStorage } from '../../ui-cache/rallar-black-box-ui-storage.ts';

export function browserUiStorage(): RallarBlackBoxUiStorage | undefined {
    if (typeof window === 'undefined') {
        return undefined;
    }

    return window.localStorage;
}
