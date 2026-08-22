export function tuningPointerTargetsObject(value: unknown, pointer: string): boolean {
    let current = value;
    for (const token of tuningPointerTokens(pointer)) {
        if (Array.isArray(current)) {
            const index = Number(token);
            if (!Number.isInteger(index) || index < 0 || index >= current.length) {
                return false;
            }
            current = current[index];
        }
        else if (current && typeof current === 'object') {
            if (!Object.prototype.hasOwnProperty.call(current, token)) {
                return false;
            }
            current = (current as Record<string, unknown>)[token];
        }
        else {
            return false;
        }
    }
    return Boolean(current) && typeof current === 'object' && !Array.isArray(current);
}

export function tuningPointerTokens(pointer: string): string[] {
    if (!pointer.startsWith('/')) {
        throw new Error(`Invalid JSON Pointer ${pointer}.`);
    }
    return pointer.split('/').slice(1).map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

export function tuningSchemaPathToPointer(path: string): string {
    if (path === '$') {
        return '';
    }
    const tokens: string[] = [];
    const pattern = /\.([^.[\]]+)|\[(\d+)\]|\["((?:\\.|[^"\\])*)"\]|\['((?:\\.|[^'\\])*)'\]/g;
    for (const match of path.slice(1).matchAll(pattern)) {
        const token = match[1] ?? match[2] ?? decodeQuotedToken(match[3], match[4]);
        tokens.push(token);
    }
    return tokens.map((token) => `/${escapePointerToken(token)}`).join('');
}

export function tuningAgentIssuePointer(base: string, message: string): string {
    const structuralTokens: string[] = [];
    message.split(': ').forEach((segment, segmentIndex) => {
        if (segmentIndex > 0 && /^recipe\.(?:load|run)\.recipe(?:\.|$)/.test(segment)) {
            structuralTokens.push('recipe');
        }
        for (const match of segment.matchAll(/\b(commands|groups)\[(\d+)\]/g)) {
            structuralTokens.push(match[1] ?? 'commands', match[2] ?? '0');
        }
    });
    const fieldMatches = [...message.matchAll(
        /\b(?:rtc\.stream|rtc|loop|parallel)\.([A-Za-z][A-Za-z0-9]*)/g
    )];
    const field = fieldMatches.at(-1)?.[1];
    const suffix = [...structuralTokens, ...(field ? [field] : [])]
        .map((token) => `/${escapePointerToken(token)}`).join('');
    return `${base}${suffix}`;
}

export function tuningPreflightIssuePointer(base: string, message: string): string {
    const path = message.slice(0, message.indexOf(':'));
    return path.startsWith('$') ? `${base}${tuningSchemaPathToPointer(path)}` : base;
}

function escapePointerToken(token: string): string {
    return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

function decodeQuotedToken(doubleQuoted?: string, singleQuoted?: string): string {
    if (doubleQuoted !== undefined) {
        return JSON.parse(`"${doubleQuoted}"`) as string;
    }
    return (singleQuoted ?? '').replaceAll('\\\'', '\'').replaceAll('\\\\', '\\');
}
