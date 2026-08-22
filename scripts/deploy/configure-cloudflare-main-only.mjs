#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const expectedWorkers = ['rallar-kit', 'relic-hunters-v1'];
const pagesProject = 'ar-eye-hunter';

function requiredEnvironment(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is required`);
    }
    return value;
}

function isMainOnlyTrigger(trigger) {
    return (
        Array.isArray(trigger.branch_includes) &&
        trigger.branch_includes.length === 1 &&
        trigger.branch_includes[0] === 'main' &&
        Array.isArray(trigger.branch_excludes) &&
        trigger.branch_excludes.length === 0
    );
}

function findProductionTrigger(workerName, triggers) {
    const mainOnlyCandidates = triggers.filter(isMainOnlyTrigger);
    const candidates = mainOnlyCandidates.length > 0
        ? mainOnlyCandidates
        : triggers.filter(
            (trigger) =>
                typeof trigger.trigger_name === 'string' &&
                /(^|\s)production(\s|$)/i.test(trigger.trigger_name) &&
                !/non-production/i.test(trigger.trigger_name)
        );
    if (candidates.length !== 1) {
        throw new Error(
            `Expected one production trigger for ${workerName}, found ${candidates.length}; no changes applied`
        );
    }
    return candidates[0];
}

function assertTriggerIdentity(workerName, trigger) {
    if (!trigger || typeof trigger.trigger_uuid !== 'string' || trigger.trigger_uuid.length === 0) {
        throw new Error(`Cloudflare returned an invalid trigger for ${workerName}; no changes applied`);
    }
}

export async function configureCloudflareMainOnly({
    accountId,
    apiBaseUrl,
    fetchImpl,
    output,
    token
}) {
    const normalizedApiBaseUrl = apiBaseUrl.replace(/\/$/, '');
    async function request(method, resourcePath, body) {
        const response = await fetchImpl(`${normalizedApiBaseUrl}${resourcePath}`, {
            method,
            headers: {
                authorization: `Bearer ${token}`,
                ...(body === undefined ? {} : { 'content-type': 'application/json' })
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.success !== true) {
            const providerErrors = Array.isArray(payload?.errors)
                ? payload.errors
                    .map((error) => error?.message)
                    .filter(Boolean)
                    .join('; ')
                : '';
            throw new Error(
                `Cloudflare ${method} ${resourcePath} failed with HTTP ${response.status}${
                    providerErrors ? `: ${providerErrors}` : ''
                }`
            );
        }
        return payload.result;
    }

    const accountPath = `/accounts/${encodeURIComponent(accountId)}`;

    // Complete every discovery read before the first mutation. A renamed or
    // missing project must fail closed instead of partially changing production.
    const scripts = await request('GET', `${accountPath}/workers/scripts`);
    if (!Array.isArray(scripts)) {
        throw new Error('Cloudflare returned an invalid Workers list');
    }

    const workers = [];
    for (const workerName of expectedWorkers) {
        const worker = scripts.find((candidate) => candidate?.id === workerName);
        if (!worker || typeof worker.tag !== 'string' || worker.tag.length === 0) {
            throw new Error(`Missing expected Cloudflare Worker: ${workerName}; no changes applied`);
        }
        workers.push({ name: workerName, tag: worker.tag });
    }

    const discoveredWorkers = [];
    for (const worker of workers) {
        const triggerPath = `${accountPath}/builds/workers/${encodeURIComponent(worker.tag)}/triggers`;
        const triggers = await request('GET', triggerPath);
        if (!Array.isArray(triggers)) {
            throw new Error(
                `Cloudflare returned an invalid trigger list for ${worker.name}; no changes applied`
            );
        }
        const productionTrigger = findProductionTrigger(worker.name, triggers);
        assertTriggerIdentity(worker.name, productionTrigger);
        const previewTriggers = triggers.filter((trigger) => trigger !== productionTrigger);
        for (const trigger of previewTriggers) {
            assertTriggerIdentity(worker.name, trigger);
        }
        discoveredWorkers.push({ ...worker, productionTrigger, previewTriggers });
    }

    const pagesPath = `${accountPath}/pages/projects/${encodeURIComponent(pagesProject)}`;
    const pages = await request('GET', pagesPath);
    if (pages?.name !== pagesProject || pages?.source?.type !== 'github') {
        throw new Error(
            `Expected GitHub-backed Cloudflare Pages project ${pagesProject}; no changes applied`
        );
    }

    for (const worker of discoveredWorkers) {
        if (!isMainOnlyTrigger(worker.productionTrigger)) {
            await request(
                'PATCH',
                `${accountPath}/builds/triggers/${encodeURIComponent(worker.productionTrigger.trigger_uuid)}`,
                { branch_includes: ['main'], branch_excludes: [] }
            );
        }
        for (const previewTrigger of worker.previewTriggers) {
            await request(
                'DELETE',
                `${accountPath}/builds/triggers/${encodeURIComponent(previewTrigger.trigger_uuid)}`
            );
        }
    }

    const desiredPagesConfiguration = {
        production_branch: 'main',
        source: {
            config: {
                production_branch: 'main',
                production_deployments_enabled: true,
                preview_deployment_setting: 'none'
            }
        }
    };
    const pagesConfig = pages.source.config;
    if (
        pages.production_branch !== 'main' ||
        pagesConfig?.production_branch !== 'main' ||
        pagesConfig?.production_deployments_enabled !== true ||
        pagesConfig?.preview_deployment_setting !== 'none'
    ) {
        await request('PATCH', pagesPath, desiredPagesConfiguration);
    }

    for (const worker of workers) {
        const verifiedTriggers = await request(
            'GET',
            `${accountPath}/builds/workers/${encodeURIComponent(worker.tag)}/triggers`
        );
        if (
            !Array.isArray(verifiedTriggers) ||
            verifiedTriggers.length !== 1 ||
            !isMainOnlyTrigger(verifiedTriggers[0])
        ) {
            throw new Error(`Cloudflare Worker ${worker.name} did not verify as main-only`);
        }
    }

    const verifiedPages = await request('GET', pagesPath);
    if (
        verifiedPages?.production_branch !== 'main' ||
        verifiedPages?.source?.config?.production_branch !== 'main' ||
        verifiedPages?.source?.config?.production_deployments_enabled !== true ||
        verifiedPages?.source?.config?.preview_deployment_setting !== 'none'
    ) {
        throw new Error(`Cloudflare Pages project ${pagesProject} did not verify as main-only`);
    }

    output('Cloudflare branch controls verified: main only');
}

async function main() {
    if (process.argv.slice(2).join(' ') !== '--apply') {
        throw new Error('Refusing to change Cloudflare without the exact --apply argument');
    }

    await configureCloudflareMainOnly({
        accountId: requiredEnvironment('CLOUDFLARE_ACCOUNT_ID'),
        apiBaseUrl: process.env.CLOUDFLARE_API_BASE_URL ?? 'https://api.cloudflare.com/client/v4',
        fetchImpl: fetch,
        output: (message) => console.log(message),
        token: requiredEnvironment('CLOUDFLARE_API_TOKEN')
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
