function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function computeStringEndIndex(source: string, openIndex: number): number {
    const quote = source[openIndex];
    let index = openIndex + 1;
    while (index < source.length) {
        const char = source[index];
        if (char === '\\') {
            index += 2;
            continue;
        }
        if (char === quote) {
            return index + 1;
        }
        index += 1;
    }
    return source.length;
}

// Braces are counted outside strings and comments so the block ends at its own closing brace
// rather than at whatever statement happens to follow it. Regex literals are not lexed: the
// retention route holds none, and a miscount returns -1 here instead of mis-bounding silently.
function computeBlockEndIndex(source: string, openBraceIndex: number): number {
    let depth = 0;
    let index = openBraceIndex;
    while (index < source.length) {
        const char = source[index];
        const next = source[index + 1];
        if (char === '/' && next === '/') {
            const lineEnd = source.indexOf('\n', index);
            index = lineEnd < 0 ? source.length : lineEnd;
            continue;
        }
        if (char === '/' && next === '*') {
            const commentEnd = source.indexOf('*/', index + 2);
            index = commentEnd < 0 ? source.length : commentEnd + 2;
            continue;
        }
        if (char === '\'' || char === '"' || char === '`') {
            index = computeStringEndIndex(source, index);
            continue;
        }
        if (char === '{') {
            depth += 1;
        }
        if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
        index += 1;
    }
    return -1;
}

Deno.test('manual retention route cannot close sockets delete artifacts or read bodies', async () => {
    const source = await Deno.readTextFile(new URL('../src/main.ts', import.meta.url));
    const startMarker = 'if (request.method === \'POST\' && url.pathname === \'/retention/cleanup\') {';
    const start = source.indexOf(startMarker);
    assert(start >= 0, 'Retention route block should keep its opening guard.');
    const end = computeBlockEndIndex(source, start + startMarker.length - 1);
    assert(end > start, 'Retention route block should close with a matching brace.');
    const route = source.slice(start, end + 1);

    assert(route.includes('handleRetentionCleanup({'));
    assert(route.includes('persist: () => snapshotPersistence.persist()'));
    for (
        const forbidden of [
            'closeRunSockets',
            'closeDeletedRunSockets',
            'artifactRecorder',
            'readJsonBody',
            'readTextBody'
        ]
    ) {
        assert(!route.includes(forbidden), `Manual retention route must not call ${forbidden}.`);
    }
});
