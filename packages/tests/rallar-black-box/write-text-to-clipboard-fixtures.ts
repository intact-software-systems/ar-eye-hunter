import { vi } from 'vitest';

export interface ClipboardFailure {
    readonly name: string;
    readonly error: string;
    arrange(): void;
}

/** The two clipboard failures writeTextToClipboard turns into visible messages. */
export const CLIPBOARD_FAILURES: readonly ClipboardFailure[] = [
    {
        name: 'an unavailable clipboard',
        error: 'Clipboard access is unavailable in this browser.',
        arrange: () => {
            vi.spyOn(navigator, 'clipboard', 'get').mockImplementation(() => Reflect.get({}, 'clipboard'));
        }
    },
    {
        name: 'a rejected copy',
        error: 'Unable to copy to the clipboard. Check browser permissions and try again.',
        arrange: () => {
            vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
        }
    }
];
