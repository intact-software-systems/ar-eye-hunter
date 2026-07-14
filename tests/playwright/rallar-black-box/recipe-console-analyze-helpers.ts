import type { Locator, Page } from '@playwright/test';
import type { AnalyzeUploadFile } from './recipe-console-analyze-artifacts.ts';

export const ANALYZE_SECTION_ORDER = [
    'source',
    'verdict',
    'quality',
    'performance',
    'search',
    'markdown',
] as const;

export async function chooseAnalyzeFiles(
    page: Page,
    files: readonly AnalyzeUploadFile[] | readonly string[],
): Promise<void> {
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByText('Choose files', { exact: true }).click();
    const chooser = await chooserPromise;
    if (files.every((file): file is string => typeof file === 'string')) {
        await chooser.setFiles([...files]);
    } else {
        await chooser.setFiles([...files] as AnalyzeUploadFile[]);
    }
}

export function analyzeVerdict(page: Page): Locator {
    return page.locator('[data-analyze-section="verdict"]');
}

export function analyzeSource(page: Page): Locator {
    return page.locator('[data-analyze-section="source"]');
}

export function analyzeSearch(page: Page): Locator {
    return page.locator('[data-analyze-section="search"]');
}

export function analyzePoliteAnnouncement(page: Page): Locator {
    return analyzeSource(page).locator('p[role="status"]');
}

export function analyzeLegacyRunsLink(page: Page): Locator {
    return analyzeSource(page).getByRole('link', {
        name: 'Open selected run in legacy Runs',
    });
}

export async function dropAnalyzeFilesWithReadProbe(
    page: Page,
    files: readonly AnalyzeUploadFile[],
): Promise<void> {
    await page.evaluate(() => {
        const trackedWindow = window as typeof window & {
            __analyzeDroppedFileReadCount?: number;
        };
        const originalArrayBuffer = File.prototype.arrayBuffer;
        trackedWindow.__analyzeDroppedFileReadCount = 0;
        File.prototype.arrayBuffer = function trackedArrayBuffer(): Promise<ArrayBuffer> {
            trackedWindow.__analyzeDroppedFileReadCount =
                (trackedWindow.__analyzeDroppedFileReadCount ?? 0) + 1;
            return originalArrayBuffer.call(this);
        };
    });
    await dropAnalyzeFiles(page, files);
}

export async function dropAnalyzeFiles(
    page: Page,
    files: readonly AnalyzeUploadFile[],
): Promise<void> {
    await page.locator('[data-analyze-dropzone]').evaluate((dropzone, payloads) => {
        const transfer = new DataTransfer();
        for (const payload of payloads) {
            transfer.items.add(new File(
                [payload.contents],
                payload.name,
                { type: payload.mimeType },
            ));
        }
        dropzone.dispatchEvent(new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
        }));
    }, files.map(file => ({
        name: file.name,
        mimeType: file.mimeType,
        contents: file.buffer.toString('utf8'),
    })));
}

export async function analyzeDroppedFileReadCount(page: Page): Promise<number> {
    return page.evaluate(() => (
        window as typeof window & { __analyzeDroppedFileReadCount?: number }
    ).__analyzeDroppedFileReadCount ?? 0);
}

export async function installDeferredAnalyzeFileRead(page: Page): Promise<void> {
    await page.evaluate(() => {
        const tracked = window as typeof window & {
            __analyzeDeferredRead?: {
                started: boolean;
                readCount: number;
                release(): void;
            };
        };
        const originalArrayBuffer = File.prototype.arrayBuffer;
        let release = (): void => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        tracked.__analyzeDeferredRead = {
            started: false,
            readCount: 0,
            release,
        };
        File.prototype.arrayBuffer = async function deferredArrayBuffer(): Promise<ArrayBuffer> {
            const state = tracked.__analyzeDeferredRead;
            if (state) {
                state.readCount += 1;
                if (state.readCount === 1) {
                    state.started = true;
                    await gate;
                }
            }
            return originalArrayBuffer.call(this);
        };
    });
}

export async function waitForDeferredAnalyzeFileRead(page: Page): Promise<void> {
    await page.waitForFunction(() => (
        window as typeof window & {
            __analyzeDeferredRead?: { started: boolean };
        }
    ).__analyzeDeferredRead?.started === true);
}

export async function releaseDeferredAnalyzeFileRead(page: Page): Promise<void> {
    await page.evaluate(() => (
        window as typeof window & {
            __analyzeDeferredRead?: { release(): void };
        }
    ).__analyzeDeferredRead?.release());
}

export async function deferredAnalyzeFileReadCount(page: Page): Promise<number> {
    return page.evaluate(() => (
        window as typeof window & {
            __analyzeDeferredRead?: { readCount: number };
        }
    ).__analyzeDeferredRead?.readCount ?? 0);
}

export async function pushAnalyzeContext(
    page: Page,
    identity: Readonly<{ controlRunId: string; distributedRunId: string }>,
): Promise<void> {
    await page.evaluate((nextIdentity) => {
        const url = new URL(location.href);
        url.searchParams.set('controlRunId', nextIdentity.controlRunId);
        url.searchParams.set('distributedRunId', nextIdentity.distributedRunId);
        history.pushState({}, '', url);
        dispatchEvent(new PopStateEvent('popstate'));
    }, identity);
}
