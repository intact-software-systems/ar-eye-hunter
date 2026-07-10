import type { RallarBlackBoxUiStorage } from '../../ui-persistence.ts';

export function browserUiStorage(): RallarBlackBoxUiStorage | undefined {
    if (typeof window === 'undefined') {
        return undefined;
    }

    return window.localStorage;
}
