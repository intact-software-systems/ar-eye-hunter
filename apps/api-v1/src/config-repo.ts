import { parse } from 'jsr:@std/yaml';
import { ApiConfig } from '@shared/api/api-config.ts';

type RuntimeConfigEnv = Readonly<{
    get(name: string): string | undefined;
}>;

async function loadJsonFile(fileName: string) {
    return await import(
        fileName,
        {
            with: { type: 'json' },
        }
        )
        .then((a) => a.default)
        .catch((e) => {
            console.error(e);
            return {};
        });
}

async function loadYamlFile(fileName: string) {
    try {
        const yamlText = await Deno.readTextFile(new URL(fileName, import.meta.url));
        return parse(yamlText);
    } catch (e) {
        console.error('Failed to load file', e);
        throw e;
    }
}

export async function loadOpenApiYaml() {
    return await loadYamlFile('../resources/api-v1-openapi.yaml');
}

async function loadConfigDev(): Promise<object> {
    return await loadJsonFile('../resources/web-config-dev.json');
}

async function loadConfigProd(): Promise<object> {
    return await loadJsonFile('../resources/web-config-prod.json');
}

async function loadConfig(env: string): Promise<object> {
    switch (env) {
        case 'dev':
            return await loadConfigDev();
        case 'prod':
            return await loadConfigProd();
        default:
            throw new Error(`Unknown environment: ${env}`);
    }
}

const env = Deno.env.get('ENVIRONMENT') || 'dev';

export const configuration: ApiConfig = applyRuntimeConfigOverrides(
    await loadConfig(env) as ApiConfig,
);

export function applyRuntimeConfigOverrides(
    config: ApiConfig,
    env: RuntimeConfigEnv = Deno.env,
): ApiConfig {
    const apiBaseUrl = firstNonEmpty(
        env.get('RALLAR_API_BASE_URL'),
        env.get('API_BASE_URL'),
    );
    const wsBaseUrl = firstNonEmpty(
        env.get('RALLAR_WS_BASE_URL'),
        apiBaseUrl ? toWsBaseUrl(apiBaseUrl) : undefined,
    );

    return {
        ...config,
        ...(apiBaseUrl ? { apiBaseUrl } : {}),
        ...(wsBaseUrl ? { wsBaseUrl } : {}),
    };
}

function firstNonEmpty(
    ...values: readonly (string | undefined)[]
): string | undefined {
    for (const value of values) {
        const trimmed = value?.trim();
        if (trimmed) {
            return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
        }
    }

    return undefined;
}

function toWsBaseUrl(apiBaseUrl: string): string {
    const url = new URL(apiBaseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString().replace(/\/$/, '');
}