import { expect, type Page, type Request } from '@playwright/test';

export async function assertIdleViewReads(page: Page, view: 'social' | 'sessions'): Promise<void> {
    const reads: string[] = [];
    const record = (request: Request): void => {
        const path = new URL(request.url()).pathname;
        const matches = view === 'social'
            ? /^\/api\/(friends|parties|matchmaking)\/apps\//.test(path)
            : /^\/api\/state\/apps\/[^/]+\/workspaces\/[^/]+\/(group-sessions|groups\/[^/]+\/session)$/.test(path);
        if (request.method() === 'GET' && matches) {
            reads.push(new URL(request.url()).pathname);
        }
    };
    page.on('request', record);
    try {
        // Observe longer than the removed repeat interval, with no state-changing actions during this window.
        await page.waitForTimeout(view === 'social' ? 2200 : 6200);
        expect(reads, `idle ${view} views must wait for server changes rather than poll`).toEqual([]);
    }
    finally {
        page.off('request', record);
    }
}
