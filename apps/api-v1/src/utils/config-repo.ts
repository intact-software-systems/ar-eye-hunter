import {ApiConfig} from "@shared/api/api-config.ts";

export async function loadJsonFile(fileName: string) {
    return await import (
        fileName,
        {
            with: {type: 'json'}
        }
        )
        .then(a => a.default)
        .catch(e => {
            console.error(e)
            return {}
        })
}

async function loadConfigDev(): Promise<object> {
    return await loadJsonFile('../../resources/web-config-dev.json')
}


async function loadConfigProd(): Promise<object> {
    return await loadJsonFile('../../resources/web-prod-config.json')
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

const env = Deno.env.get("ENVIRONMENT") || 'dev';

export const configuration: ApiConfig = await loadConfig(env) as ApiConfig;

