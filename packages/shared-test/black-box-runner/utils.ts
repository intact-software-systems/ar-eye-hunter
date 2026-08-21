import { readFileSync } from 'node:fs';

type ReplaceValue = string | number | boolean | undefined;
type ReplaceConfig = Record<string, ReplaceValue>;
type GeneratedReplace = Record<string, ReplaceValue>;

function asStringOrNumber(value: ReplaceValue): string | number | undefined {
    return typeof value === 'string' || typeof value === 'number'
        ? value
        : undefined;
}

function randomIban(countryCode: string, technicalOrgNum: string | number): string {
    return countryCode + randomInteger(20, 90) + technicalOrgNum + randomInteger(1000000, 9999999);
}

function randomInteger(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min)) + min;
}

function generatedEntry(value: string, config: ReplaceConfig): GeneratedReplace | undefined {
    switch (value) {
        case 'uuid':
            return {
                uuid: crypto.randomUUID()
            };
        case 'iban': {
            const bankOrgID = asStringOrNumber(config.bankOrgID);
            return {
                iban: bankOrgID
                    ? randomIban(String(config.country), bankOrgID)
                    : undefined
            };
        }
        case 'date':
            return {
                date: new Date().toISOString().slice(0, 10)
            };
        case 'bankOrgID':
            return {
                bankOrgID: randomInteger(1000, 9999999).toString()
            };
        case 'orgId':
            return {
                orgId: '0' + randomInteger(10000000000000000, 99999999999999999).toString()
            };
        case 'amount':
            return {
                amount: randomInteger(1, 99999999)
            };
        default:
            return undefined;
    }
}

function generateReplace(generate: string[], config: ReplaceConfig): GeneratedReplace {
    const filtered = generate
        .map((value) => generatedEntry(value, config))
        .filter((gen): gen is GeneratedReplace => gen !== undefined);

    const generated = filtered.length === 0
        ? {}
        : filtered.reduce<GeneratedReplace>((a, b) => {
            return { ...a, ...b };
        }, {});

    if (generate.includes('iban') && !generated.iban) {
        const bankOrgID = asStringOrNumber(config.bankOrgID) ||
            asStringOrNumber(generated.bankOrgID) ||
            '';

        return {
            ...generated,
            iban: randomIban(String(config.country), bankOrgID)
        };
    }

    return generated;
}

function parseYamlScalar(value: string): unknown {
    const trimmed = value.trim();
    if (!trimmed) {
        return '';
    }

    if (trimmed === 'true') {
        return true;
    }

    if (trimmed === 'false') {
        return false;
    }

    if (trimmed === 'null') {
        return null;
    }

    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith('\'') && trimmed.endsWith('\''))
    ) {
        return trimmed.slice(1, -1);
    }

    const number = Number(trimmed);
    return Number.isFinite(number) && trimmed.match(/^-?\d+(\.\d+)?$/)
        ? number
        : trimmed;
}

function parseSimpleYaml(text: string): unknown {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        .reduce<Record<string, unknown>>((result, line) => {
            const separator = line.indexOf(':');
            if (separator <= 0) {
                throw new Error('Unsupported YAML line: ' + line);
            }

            const key = line.slice(0, separator).trim();
            const value = line.slice(separator + 1);
            result[key] = parseYamlScalar(value);
            return result;
        }, {});
}

function toReplaceGlobal(generate: string[], replace: ReplaceConfig): GeneratedReplace {
    const defaultReplace: ReplaceConfig = {
        env: 'DEV',
        sys: 'LED',
        source: 'INT',
        country: 'NO',
        currency: 'NOK',
        userID: 'aTestTool'
    };

    const generatedReplace = generateReplace(
        generate,
        {
            ...defaultReplace,
            ...replace
        }
    );

    return {
        ...defaultReplace,
        ...replace,
        ...generatedReplace
    };
}

function inputReplacesToJson(input?: string): Record<string, string> {
    if (!input || input.length <= 1) {
        return {};
    }

    const values = input.split(',');
    if (values.length <= 0) {
        return {};
    }

    let resultJson: Record<string, string> = {};

    for (const element of values) {
        const obj: Record<string, string> = {};

        const value = element.split(':=');
        if (value.length !== 2) {
            console.warn('Ignoring replace. Failed to parse replace in input ' + input + ' Failed with ' + value);
            return {};
        }

        obj[value[0]] = value[1];

        resultJson = { ...obj, ...resultJson };
    }

    return resultJson;
}

let workingDirectory = '.';

function toPath(name: string): string {
    return workingDirectory + '/' + name;
}

function getValuePaths(currPath: string, item: unknown, valuePaths: string[] = []): string[] {
    if (!Array.isArray(item) && typeof item !== 'object') {
        valuePaths.push(currPath);
    }

    if (Array.isArray(item)) {
        item.forEach((el, idx) => getValuePaths(`${currPath}.${idx}`, el, valuePaths));
    }
    else if (item && typeof item === 'object') {
        Object.entries(item)
            .forEach(([key, value]) => {
                getValuePaths(`${currPath}.${key}`, value, valuePaths);
            });
    }

    return valuePaths;
}

export function getAllValuePaths(data: Record<string, unknown>): string[] {
    return Object.entries(data)
        .map(([key, value]) => {
            return [...new Set([key, ...getValuePaths(key, value)])];
        })
        .flatMap((a) => a);
}

export async function loadJsonFile(fileName: string): Promise<unknown> {
    return await import(
        fileName,
        {
            with: { type: 'json' }
        }
    )
        .then((a) => a.default)
        .catch((e) => {
            console.error(e);
            return {};
        });
}

function setWorkingDirectory(dir?: string): string {
    workingDirectory = dir || '.';
    return workingDirectory;
}

function openFile(fileName: string): unknown {
    const text = readFileSync(toPath(fileName)).toString();

    if (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) {
        return parseSimpleYaml(text);
    }

    return JSON.parse(text);
}

function resolvePathData(path: string, obj: Record<string, unknown>): unknown {
    const resolvedData = path.split('.')
        .reduce<unknown>((prev, curr) => {
            return prev && typeof prev === 'object'
                ? (prev as Record<string, unknown>)[curr]
                : null;
        }, obj);

    if (resolvedData === undefined) {
        throw 'Cannot resolve ' + path + ' among available: [' + Object.keys(obj) + ']';
    }

    return resolvedData;
}

export default {
    setWorkingDirectory,

    openFile,

    toReplace: (generate?: string[], replace?: ReplaceConfig): GeneratedReplace => {
        return toReplaceGlobal(generate || [], replace || {});
    },

    generateReplace: (generate: string[] = [], config: ReplaceConfig = {}): GeneratedReplace => {
        if (!generate.length) {
            return {};
        }

        return generateReplace(generate || [], config || {});
    },

    inputReplacesToJson: (csv?: string): Record<string, string> => inputReplacesToJson(csv),

    resolvePathData
};
