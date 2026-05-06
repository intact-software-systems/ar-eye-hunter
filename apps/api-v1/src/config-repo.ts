import { parse } from 'jsr:@std/yaml';
import { ApiConfig } from '@shared/api/api-config.ts';

async function loadJsonFile(fileName: string) {
    return await import (
        fileName,
        {
            with: { type: 'json' }
        }
        )
        .then(a => a.default)
        .catch(e => {
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

export const configuration: ApiConfig = await loadConfig(env) as ApiConfig;


export type LoginClientData = {
    readonly clientId: string,
    readonly username: string,
    readonly password: string
}

export const authorisedClients: LoginClientData[] = await loadJsonFile('../resources/authorised-clients.json');
