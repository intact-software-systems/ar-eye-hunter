import { expect, type Page, type Request } from '@playwright/test';

export async function assertIdleSocialReads(page: Page): Promise<void> {
    const reads: string[] = [];
    const record = (request: Request): void => {
        if (
            request.method() === 'GET' &&
            /^\/api\/(friends|parties|matchmaking)\/apps\//.test(new URL(request.url()).pathname)
        ) {
            reads.push(new URL(request.url()).pathname);
        }
    };
    page.on('request', record);
    try {
        // A measured quiet window is the requirement: an idle UI must not repeat its one-second GET loops.
        await page.waitForTimeout(2200);
        expect(reads, 'idle social views must wait for server changes rather than poll').toEqual([]);
    }
    finally {
        page.off('request', record);
    }
}
