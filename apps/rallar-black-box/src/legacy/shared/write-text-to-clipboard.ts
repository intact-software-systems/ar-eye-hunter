import { Either } from '@shared/resilience/Either.ts';

export async function writeTextToClipboard(text: string): Promise<Either<string, string>> {
    if (!navigator.clipboard?.writeText) {
        return Either.ofLeft('Clipboard access is unavailable in this browser.');
    }
    try {
        await navigator.clipboard.writeText(text);
        return Either.ofRight(text);
    }
    catch {
        return Either.ofLeft('Unable to copy to the clipboard. Check browser permissions and try again.');
    }
}
