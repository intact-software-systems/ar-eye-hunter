import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const BUNDLED_DEMO_CLIENT_IDS = readBundledDemoClientIds();

const RETIRED_PRODUCTION_NAMES = ['ENVIRONMENT', 'RALLAR_PRODUCTION_HARDENING'];

const REQUIRED_SHARED_VALUES = new Map([
    ['AUTH_ADMIN_CLIENT_IDS', undefined],
    ['RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS', undefined],
    ['METERED_APP_NAME', undefined]
]);

const REQUIRED_SHARED_SECRETS = [
    'RALLAR_AUTH_CREDENTIAL_SECRET',
    'METERED_API_KEY',
    'RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET'
];

export function validateDenoDeployApiEnvironment(document, target) {
    if (target !== 'api-v1' && target !== 'relic') {
        throw new TypeError('Target must be api-v1 or relic.');
    }

    const productionEntries = collectProductionEnvironmentEntries(document);
    const errors = [];
    for (const name of RETIRED_PRODUCTION_NAMES) {
        if (productionEntries.has(name)) {
            errors.push(`${name} is retired and must be removed from the production context.`);
        }
    }
    const productionProfile = requireProductionProfile(errors, productionEntries);
    for (const [name, expectedValue] of REQUIRED_SHARED_VALUES) {
        requireVisibleValue({ errors, entries: productionEntries, name, expectedValue });
    }
    if (productionProfile === 'prod') {
        requireNoBundledDemoClientIds(errors, productionEntries, 'AUTH_ADMIN_CLIENT_IDS');
        requireNoBundledDemoClientIds(
            errors,
            productionEntries,
            'RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS'
        );
    }
    for (const name of REQUIRED_SHARED_SECRETS) {
        requireSecret(errors, productionEntries, name);
    }
    if (target === 'relic' && productionEntries.has('RELIC_REST_AUTH_MODE')) {
        errors.push(
            'RELIC_REST_AUTH_MODE is profile-owned and must be removed from the production context.'
        );
    }
    return errors;
}

function requireProductionProfile(errors, entries) {
    const name = 'RALLAR_API_CONFIGURATION_PROFILE';
    const entry = entries.get(name);
    if (!entry) {
        errors.push(`${name} is missing from the production context.`);
        return undefined;
    }
    if (entry.secret || !entry.value) {
        errors.push(`${name} must be a visible non-empty production value.`);
        return undefined;
    }
    if (entry.value !== 'prod' && entry.value !== 'prod-hardened') {
        errors.push(`${name} must equal prod or prod-hardened in the production context.`);
        return undefined;
    }
    return entry.value;
}

function requireNoBundledDemoClientIds(errors, entries, name) {
    const entry = entries.get(name);
    if (!entry || entry.secret || !entry.value) {
        return;
    }
    const clientIds = entry.value.split(',').map((clientId) => clientId.trim());
    if (clientIds.some((clientId) => BUNDLED_DEMO_CLIENT_IDS.has(clientId))) {
        errors.push(`${name} must not include bundled demo client IDs for the prod profile.`);
    }
}

function collectProductionEnvironmentEntries(document) {
    const entries = new Map();
    visitEnvironmentDocument(document, entries);
    return entries;
}

function visitEnvironmentDocument(value, entries) {
    if (Array.isArray(value)) {
        for (const item of value) {
            visitEnvironmentDocument(item, entries);
        }
        return;
    }
    if (!isObject(value)) {
        return;
    }

    const explicitName = readFirstString(value, ['name', 'key', 'variable']);
    if (explicitName && isProductionEnvironmentEntry(value)) {
        entries.set(explicitName, toEnvironmentEntry(value));
    }

    for (const [key, child] of Object.entries(value)) {
        if (isEnvironmentName(key) && isProductionEnvironmentEntry(child)) {
            entries.set(key, toEnvironmentEntry(child));
            continue;
        }
        visitEnvironmentDocument(child, entries);
    }
}

function toEnvironmentEntry(value) {
    if (typeof value === 'string') {
        return { value, secret: false };
    }
    if (!isObject(value)) {
        return { value: undefined, secret: value === null };
    }

    return {
        value: typeof value.value === 'string' ? value.value : undefined,
        secret: value.secret === true ||
            value.isSecret === true ||
            value.value === null ||
            readFirstString(value, ['type', 'kind', 'visibility'])?.toLowerCase() === 'secret'
    };
}

function isProductionEnvironmentEntry(value) {
    if (!isObject(value)) {
        return true;
    }
    const rawContexts = value.contexts ?? value.context;
    if (rawContexts === undefined || rawContexts === null || rawContexts === 'all') {
        return true;
    }
    const contexts = Array.isArray(rawContexts) ? rawContexts : [rawContexts];
    return contexts.some(
        (context) => typeof context === 'string' && context.toLowerCase() === 'production'
    );
}

function requireVisibleValue({ errors, entries, name, expectedValue }) {
    const entry = entries.get(name);
    if (!entry) {
        errors.push(`${name} is missing from the production context.`);
        return;
    }
    if (entry.secret || !entry.value) {
        errors.push(`${name} must be a visible non-empty production value.`);
        return;
    }
    if (expectedValue !== undefined && entry.value !== expectedValue) {
        errors.push(`${name} must equal ${expectedValue} in the production context.`);
    }
}

function requireSecret(errors, entries, name) {
    const entry = entries.get(name);
    if (!entry) {
        errors.push(`${name} is missing from the production context.`);
        return;
    }
    if (!entry.secret) {
        errors.push(`${name} must be configured as a platform secret.`);
    }
}

function isEnvironmentName(value) {
    return /^[A-Z][A-Z0-9_]+$/u.test(value);
}

function readFirstString(object, names) {
    for (const name of names) {
        if (typeof object[name] === 'string') {
            return object[name];
        }
    }
    return undefined;
}

function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBundledDemoClientIds() {
    const url = new URL('../../apps/api-v1/resources/authorised-clients.json', import.meta.url);
    const clients = JSON.parse(readFileSync(url, 'utf8'));
    if (
        !Array.isArray(clients) ||
        clients.some((client) => !isObject(client) || typeof client.clientId !== 'string')
    ) {
        throw new TypeError('Bundled API-v1 clients must contain string clientId values.');
    }
    return new Set(clients.map((client) => client.clientId));
}

async function main(args) {
    const target = readOption(args, '--target');
    const file = readOption(args, '--file');
    const document = JSON.parse(await readFile(file, 'utf8'));
    const errors = validateDenoDeployApiEnvironment(document, target);
    if (errors.length > 0) {
        for (const error of errors) {
            console.error(`- ${error}`);
        }
        process.exitCode = 1;
        return;
    }
    console.log(`Verified ${target} Deno Deploy production configuration.`);
}

function readOption(args, name) {
    const index = args.indexOf(name);
    const value = index >= 0 ? args[index + 1] : undefined;
    if (!value || value.startsWith('--')) {
        throw new TypeError(`${name} requires a value.`);
    }
    return value;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    await main(process.argv.slice(2));
}
