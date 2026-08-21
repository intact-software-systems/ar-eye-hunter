import { countMatches, lineFromOffset, lineOffsets, skipWhitespaceAndComments } from './source-text.mjs';

export function estimateCyclomaticComplexity(text) {
    return (
        1 +
        countMatches(text, /\bif\s*\(/g) +
        countMatches(text, /\bcase\s+[^:]+:/g) +
        countMatches(text, /\bcatch\s*(?:\(|\{)/g) +
        countMatches(text, /\bfor\s*\(/g) +
        countMatches(text, /\bwhile\s*\(/g)
    );
}

export function extractRouteHandlerRanges(text) {
    const ranges = [];
    const routePattern = /app\.(get|post|put|patch|delete)\s*\(/g;
    let match;

    while ((match = routePattern.exec(text)) !== null) {
        const arrow = text.indexOf('=>', match.index);
        if (arrow === -1) {
            continue;
        }

        const bodyStart = skipWhitespaceAndComments(text, arrow + 2);
        if (text[bodyStart] !== '{') {
            continue;
        }

        let depth = 0;
        let bodyEnd = -1;
        for (let index = bodyStart; index < text.length; index += 1) {
            if (text[index] === '{') {
                depth += 1;
            }
            else if (text[index] === '}') {
                depth -= 1;
                if (depth === 0) {
                    bodyEnd = index + 1;
                    break;
                }
            }
        }

        if (bodyEnd !== -1) {
            ranges.push({ start: bodyStart, end: bodyEnd });
        }
    }

    return ranges;
}

export function scanFactorySpacing(raw, factory, maxBlockLineCount) {
    const messages = [];
    const bodyLines = raw.slice(factory.bodyStart + 1, factory.bodyEnd).split('\n');
    const bodyStartLine = 1 + lineFromOffset(lineOffsets(raw), factory.bodyStart);
    let runLength = 0;
    let runStartLine = bodyStartLine + 1;

    for (let index = 0; index < bodyLines.length; index += 1) {
        const lineNumber = bodyStartLine + index + 1;
        if (bodyLines[index].trim() === '') {
            if (runLength > maxBlockLineCount) {
                messages.push(
                    toFactorySpacingMessage({
                        name: factory.name,
                        length: runLength,
                        startLine: runStartLine,
                        endLine: lineNumber - 1
                    })
                );
            }

            runLength = 0;
            runStartLine = lineNumber + 1;
            continue;
        }

        if (runLength === 0) {
            runStartLine = lineNumber;
        }
        runLength += 1;
    }

    if (runLength > maxBlockLineCount) {
        messages.push(
            toFactorySpacingMessage({
                name: factory.name,
                length: runLength,
                startLine: runStartLine,
                endLine: bodyStartLine + bodyLines.length
            })
        );
    }

    return messages;
}

export function scanFactoryDefaults(input) {
    const { raw, lines, factory, limits } = input;
    const optionalFields = findOptionalFields(lines, factory.paramType);
    if (optionalFields.length < limits.optionalFieldMinimum) {
        return [];
    }

    const escapedParam = escapeRegExp(factory.paramName);
    const fallbackPattern = new RegExp(`\\b${escapedParam}\\.([A-Za-z0-9_]+)\\s*\\?\\?`, 'gu');
    const usedFallbacks = new Set();
    const bodyText = raw.slice(factory.bodyStart, factory.bodyEnd);
    let match;

    while ((match = fallbackPattern.exec(bodyText)) !== null) {
        usedFallbacks.add(match[1]);
    }

    if (usedFallbacks.size < limits.defaultFieldMinimum) {
        return [];
    }

    const baseName = factory.name.slice('create'.length);
    if (hasDefaultFactory(raw, baseName)) {
        return [];
    }

    const fieldNames = optionalFields.map((field) => field.name).join(', ');
    return [
        `Factory ${factory.name} uses optional input fields (${fieldNames}) with ` +
        `inline defaults. Prefer required factory input and createDefault${baseName}() ` +
        'to assemble common production defaults at the composition root.'
    ];
}

function findOptionalFields(lines, typeName) {
    const escapedType = escapeRegExp(typeName);
    const startPattern = new RegExp(
        `^(?:export\\s+)?(?:type\\s+${escapedType}` +
            `(?:\\s*<[^>]+>)?\\s*=\\s*(?:Readonly\\s*<\\s*)?` +
            `|interface\\s+${escapedType}(?:\\s*<[^>]+>)?\\s*)\\{`,
        'u'
    );

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        if (!startPattern.test(lines[lineIndex])) {
            continue;
        }

        const optionalFields = [];
        let depth = 0;

        for (let fieldLineIndex = lineIndex; fieldLineIndex < lines.length; fieldLineIndex += 1) {
            const clean = lines[fieldLineIndex].split('//')[0];
            const openCount = (clean.match(/\{/gu) ?? []).length;
            const closeCount = (clean.match(/\}/gu) ?? []).length;

            if (fieldLineIndex > lineIndex) {
                const fieldMatch = clean.match(/^\s*(?:readonly\s+)?([A-Za-z0-9_"]+)\s*\?\s*:/u);
                if (fieldMatch) {
                    optionalFields.push({
                        line: fieldLineIndex + 1,
                        name: fieldMatch[1],
                        text: clean.trim()
                    });
                }
            }

            depth += openCount - closeCount;
            if (fieldLineIndex > lineIndex && depth <= 0) {
                return optionalFields;
            }
        }
    }

    return [];
}

function hasDefaultFactory(raw, baseName) {
    return new RegExp(`\\bcreateDefault${escapeRegExp(baseName)}\\b`, 'u').test(raw);
}

function toFactorySpacingMessage(input) {
    return (
        `Factory ${input.name} has a ${input.length}-line block without blank-line ` +
        `separation from line ${input.startLine} to ${input.endLine}. ` +
        'Group boundary decoding, ' +
        'service wiring, route setup, and result mapping into visible phases.'
    );
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
