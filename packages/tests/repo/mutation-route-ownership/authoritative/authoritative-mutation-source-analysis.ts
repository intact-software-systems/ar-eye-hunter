interface ExtractBodyInput {
    readonly source: string;
    readonly signature: RegExp;
    readonly label: string;
}

interface MatchingDelimiterInput {
    readonly source: string;
    readonly start: number;
    readonly open: string;
    readonly close: string;
    readonly label: string;
}

export function readMethodBody(source: string, name: string): string {
    return extractBody({
        source,
        signature: new RegExp(
            `^\\s*(?:public\\s+|private\\s+|protected\\s+)?(?:async\\s+)?${name}\\s*\\(`,
            'm'
        ),
        label: name
    });
}

export function readFunctionBody(source: string, name: string): string {
    return extractBody({
        source,
        signature: new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm'),
        label: name
    });
}

export function readBranchBody(source: string, marker: string): string {
    const start = source.indexOf(marker);
    if (start < 0) {
        throw new Error(`Missing branch: ${marker}`);
    }
    return balancedBody(source, source.indexOf('{', start), marker);
}

function extractBody({ source, signature, label }: ExtractBodyInput): string {
    const match = signature.exec(source);
    if (!match) {
        throw new Error(`Missing function or method: ${label}`);
    }
    const parametersStart = source.indexOf('(', match.index);
    const parametersEnd = matchingDelimiter({
        source,
        start: parametersStart,
        open: '(',
        close: ')',
        label
    });
    const bodyStart = source.indexOf('{', parametersEnd + 1);
    const body = balancedBody(source, bodyStart, label);
    return source.slice(match.index, bodyStart) + body;
}

function matchingDelimiter({ source, start, open, close, label }: MatchingDelimiterInput): number {
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
        if (source[index] === open) {
            depth += 1;
        }
        if (source[index] === close) {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    throw new Error(`Unclosed signature: ${label}`);
}

function balancedBody(source: string, bodyStart: number, label: string): string {
    if (bodyStart < 0) {
        throw new Error(`Missing body: ${label}`);
    }
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
        if (source[index] === '{') {
            depth += 1;
        }
        if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) {
                return source.slice(bodyStart, index + 1);
            }
        }
    }
    throw new Error(`Unclosed body: ${label}`);
}
