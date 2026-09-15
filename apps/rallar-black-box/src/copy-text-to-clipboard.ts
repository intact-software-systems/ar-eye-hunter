/** The browser clipboard effect returns expected availability and permission failures. */
export async function copyTextToClipboard(text: string): Promise<string | undefined> {
    if (!navigator.clipboard?.writeText) {
        return 'Clipboard access is unavailable in this browser.';
    }
    try {
        await navigator.clipboard.writeText(text);
        return undefined;
    }
    catch {
        return 'Unable to copy to the clipboard. Check browser permissions and try again.';
    }
}
