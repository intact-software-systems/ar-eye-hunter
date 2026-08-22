import { chromium, type Page } from 'playwright';

const baseUrl = process.env.RALLAR_BLACK_BOX_HEADLESS_PREVIEW_URL ?? 'http://127.0.0.1:5179';
const forbiddenPathParts = [
    '/distributed-runs',
    '/fleet',
    '/runs',
    '/artifacts',
    '/run-manager',
    '/analysis',
    '/reports'
];
const agentId = '<rendered-smoke-agent>';

function headlessUrl(): string {
    const url = new URL('/headless/', baseUrl);
    url.searchParams.set('mode', 'control');
    url.searchParams.set('provider', 'simulated');
    url.searchParams.set('autoConnect', '0');
    url.searchParams.set('runId', 'rendered-smoke-run');
    url.searchParams.set('agentId', agentId);
    url.searchParams.set('roomId', 'rendered-smoke-room');
    return url.toString();
}

async function verifyViewport(
    page: Page,
    viewport: Readonly<{ width: number; height: number; }>
): Promise<void> {
    await page.setViewportSize(viewport);
    await page.goto(headlessUrl(), { waitUntil: 'networkidle' });
    await page.locator('[data-headless-agent-root]').waitFor({ state: 'visible' });
    const lastError = await page.locator('[data-last-error]').textContent().catch(() => null);
    if (lastError) {
        throw new Error(`Headless bootstrap rendered an error: ${lastError}`);
    }
    const renderedAgentId = await page.locator('[data-agent-id]').textContent();
    if (renderedAgentId !== agentId) {
        throw new Error(`Expected rendered agent id ${agentId}; received ${renderedAgentId ?? '<missing>'}`);
    }
    const provider = await page.locator('[data-provider]').textContent();
    if (provider !== 'simulated') {
        throw new Error(`Expected simulated provider; received ${provider ?? '<missing>'}`);
    }
    const controlState = await page.locator('[data-control-state]').textContent();
    if (controlState !== 'idle') {
        throw new Error(`Expected idle control state; received ${controlState ?? '<missing>'}`);
    }
    const runtimeState = await page.locator('[data-runtime-state]').textContent();
    if (runtimeState !== 'configured') {
        throw new Error(`Expected configured runtime state; received ${runtimeState ?? '<missing>'}`);
    }
    const lastAction = await page.locator('[data-last-action]').textContent();
    if (lastAction !== 'Remote control agent configured') {
        throw new Error(`Expected configured last action; received ${lastAction ?? '<missing>'}`);
    }
    const layout = await page.evaluate(() => {
        const root = document.querySelector('[data-headless-agent-root]');
        return {
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            rootVisible: root instanceof HTMLElement && root.getBoundingClientRect().height > 0,
            renderedRows: document.querySelectorAll('dl dd').length
        };
    });
    if (!layout.rootVisible) {
        throw new Error('Headless status root is not visibly laid out.');
    }
    if (layout.scrollWidth > layout.clientWidth) {
        throw new Error(`Headless status page overflows horizontally: ${layout.scrollWidth} > ${layout.clientWidth}`);
    }
    if (layout.renderedRows < 8) {
        throw new Error(`Expected at least 8 status rows; rendered ${layout.renderedRows}.`);
    }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const consoleErrors: string[] = [];
const forbiddenRequests: string[] = [];

page.on('console', (message) => {
    if (message.type() === 'error') {
        consoleErrors.push(message.text());
    }
});

page.on('request', (request) => {
    const url = new URL(request.url());
    if (forbiddenPathParts.some((part) => url.pathname.includes(part))) {
        forbiddenRequests.push(request.url());
    }
});

try {
    await verifyViewport(page, { width: 1280, height: 720 });
    await verifyViewport(page, { width: 390, height: 844 });

    const title = await page.title();
    if (title !== 'Rallar Black Box Headless Agent') {
        throw new Error(`Unexpected page title: ${title}`);
    }

    if (consoleErrors.length > 0) {
        throw new Error(`Console errors during rendered smoke:\n${consoleErrors.join('\n')}`);
    }
    if (forbiddenRequests.length > 0) {
        throw new Error(`Headless app requested operator endpoints:\n${forbiddenRequests.join('\n')}`);
    }
}
finally {
    await browser.close();
}
