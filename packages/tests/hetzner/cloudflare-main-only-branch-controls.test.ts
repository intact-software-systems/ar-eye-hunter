import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptUrl = pathToFileURL(
    path.join(repoRoot, 'scripts/deploy/configure-cloudflare-main-only.mjs')
).href;

type RecordedRequest = {
    method: string;
    path: string;
    body: unknown;
};

type FakeCloudflareState = {
    includeAllWorkers: boolean;
    pagesPreviewSetting: 'all' | 'none';
    previewTriggerIds: Set<string>;
    requests: RecordedRequest[];
};

function cloudflareResponse(status: number, result: unknown): Response {
    return new Response(JSON.stringify({ success: status < 400, result, errors: [] }), {
        status,
        headers: { 'content-type': 'application/json' }
    });
}

function createFakeFetch(state: FakeCloudflareState): typeof fetch {
    return async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        state.requests.push({ method, path: url.pathname, body });

        if (method === 'GET' && url.pathname === '/accounts/account/workers/scripts') {
            return cloudflareResponse(200, [
                { id: 'rallar-kit', tag: 'tag-rallar' },
                ...(state.includeAllWorkers ? [{ id: 'relic-hunters-v1', tag: 'tag-relic' }] : [])
            ]);
        }

        const triggerMatch = url.pathname.match(
            /^\/accounts\/account\/builds\/workers\/(tag-rallar|tag-relic)\/triggers$/
        );
        if (method === 'GET' && triggerMatch) {
            const suffix = triggerMatch[1] === 'tag-rallar' ? 'rallar' : 'relic';
            return cloudflareResponse(200, [
                {
                    trigger_uuid: `production-${suffix}`,
                    trigger_name: 'Deploy production',
                    branch_includes: ['main'],
                    branch_excludes: []
                },
                ...(state.previewTriggerIds.has(`preview-${suffix}`)
                    ? [
                        {
                            trigger_uuid: `preview-${suffix}`,
                            trigger_name: 'Deploy non-production branches',
                            branch_includes: ['*'],
                            branch_excludes: ['main']
                        }
                    ]
                    : [])
            ]);
        }

        const deleteMatch = url.pathname.match(
            /^\/accounts\/account\/builds\/triggers\/(preview-(?:rallar|relic))$/
        );
        if (method === 'DELETE' && deleteMatch) {
            state.previewTriggerIds.delete(deleteMatch[1]);
            return cloudflareResponse(200, { trigger_uuid: deleteMatch[1] });
        }

        if (url.pathname === '/accounts/account/pages/projects/ar-eye-hunter') {
            if (method === 'GET') {
                return cloudflareResponse(200, {
                    name: 'ar-eye-hunter',
                    production_branch: 'main',
                    source: {
                        type: 'github',
                        config: {
                            production_branch: 'main',
                            production_deployments_enabled: true,
                            preview_deployment_setting: state.pagesPreviewSetting
                        }
                    }
                });
            }

            if (method === 'PATCH') {
                const payload = body as {
                    source?: { config?: { preview_deployment_setting?: 'all' | 'none'; }; };
                };
                state.pagesPreviewSetting = payload.source?.config?.preview_deployment_setting ?? 'all';
                return cloudflareResponse(200, payload);
            }
        }

        return cloudflareResponse(404, null);
    };
}

async function loadCommand(): Promise<{
    configureCloudflareMainOnly: (input: {
        accountId: string;
        apiBaseUrl: string;
        fetchImpl: typeof fetch;
        output: (message: string) => void;
        token: string;
    }) => Promise<void>;
}> {
    return await import(scriptUrl);
}

describe('Cloudflare main-only branch controls command', () => {
    it('removes preview Worker triggers and disables Pages preview deployments', async () => {
        const state: FakeCloudflareState = {
            includeAllWorkers: true,
            pagesPreviewSetting: 'all',
            previewTriggerIds: new Set(['preview-rallar', 'preview-relic']),
            requests: []
        };
        const output: string[] = [];
        const { configureCloudflareMainOnly } = await loadCommand();

        await configureCloudflareMainOnly({
            accountId: 'account',
            apiBaseUrl: 'https://cloudflare.test',
            fetchImpl: createFakeFetch(state),
            output: (message) => output.push(message),
            token: 'test-token'
        });

        expect(state.previewTriggerIds).toEqual(new Set());
        expect(state.pagesPreviewSetting).toBe('none');
        expect(
            state.requests
                .filter((request) => request.method === 'DELETE')
                .map((request) => request.path)
        ).toEqual([
            '/accounts/account/builds/triggers/preview-rallar',
            '/accounts/account/builds/triggers/preview-relic'
        ]);
        expect(state.requests.find((request) => request.method === 'PATCH')?.body).toEqual({
            production_branch: 'main',
            source: {
                config: {
                    production_branch: 'main',
                    production_deployments_enabled: true,
                    preview_deployment_setting: 'none'
                }
            }
        });
        expect(output).toEqual(['Cloudflare branch controls verified: main only']);
    });

    it('does not mutate any provider setting when preflight cannot find every expected Worker', async () => {
        const state: FakeCloudflareState = {
            includeAllWorkers: false,
            pagesPreviewSetting: 'all',
            previewTriggerIds: new Set(['preview-rallar', 'preview-relic']),
            requests: []
        };
        const { configureCloudflareMainOnly } = await loadCommand();

        await expect(
            configureCloudflareMainOnly({
                accountId: 'account',
                apiBaseUrl: 'https://cloudflare.test',
                fetchImpl: createFakeFetch(state),
                output: () => undefined,
                token: 'test-token'
            })
        ).rejects.toThrow('Missing expected Cloudflare Worker: relic-hunters-v1');

        expect(state.requests.every((request) => request.method === 'GET')).toBe(true);
        expect(state.previewTriggerIds).toEqual(new Set(['preview-rallar', 'preview-relic']));
        expect(state.pagesPreviewSetting).toBe('all');
    });
});
