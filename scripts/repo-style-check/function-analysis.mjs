import {
    findMatchingBrace,
    lineFromOffset,
    lineOffsets,
    skipWhitespaceAndComments,
    splitTopLevelItems
} from './source-text.mjs';

function extractParameterList(raw, openParenthesisIndex) {
    let depth = 0;

    for (let index = openParenthesisIndex; index < raw.length; index += 1) {
        if (raw[index] === '(') {
            depth += 1;
            continue;
        }

        if (raw[index] === ')') {
            depth -= 1;
            if (depth === 0) {
                return {
                    params: raw.slice(openParenthesisIndex + 1, index),
                    closeIndex: index
                };
            }
        }
    }

    return {
        params: null,
        closeIndex: -1
    };
}

function extractFunctionBody(raw, closeParenthesisIndex) {
    let cursor = skipWhitespaceAndComments(raw, closeParenthesisIndex + 1);
    let returnType = '';

    if (raw[cursor] === ':') {
        const returnTypeStart = cursor + 1;
        cursor = returnTypeStart;

        let parenthesisDepth = 0;
        let braceDepth = 0;
        let bracketDepth = 0;
        let angleDepth = 0;
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let inTemplateQuote = false;
        let inLineComment = false;
        let inBlockComment = false;

        for (; cursor < raw.length; cursor += 1) {
            const character = raw[cursor];
            const nextCharacter = raw[cursor + 1];

            if (inLineComment) {
                if (character === '\n') {
                    inLineComment = false;
                }
                continue;
            }

            if (inBlockComment) {
                if (character === '*' && nextCharacter === '/') {
                    inBlockComment = false;
                    cursor += 1;
                }
                continue;
            }

            if (inSingleQuote) {
                if (character === '\\') {
                    cursor += 1;
                }
                else if (character === '\'') {
                    inSingleQuote = false;
                }
                continue;
            }

            if (inDoubleQuote) {
                if (character === '\\') {
                    cursor += 1;
                }
                else if (character === '"') {
                    inDoubleQuote = false;
                }
                continue;
            }

            if (inTemplateQuote) {
                if (character === '\\') {
                    cursor += 1;
                }
                else if (character === '`') {
                    inTemplateQuote = false;
                }
                continue;
            }

            if (character === '/' && nextCharacter === '/') {
                inLineComment = true;
                cursor += 1;
                continue;
            }

            if (character === '/' && nextCharacter === '*') {
                inBlockComment = true;
                cursor += 1;
                continue;
            }

            if (character === '\'') {
                inSingleQuote = true;
                continue;
            }

            if (character === '"') {
                inDoubleQuote = true;
                continue;
            }

            if (character === '`') {
                inTemplateQuote = true;
                continue;
            }

            if (character === '(') {
                parenthesisDepth += 1;
                continue;
            }

            if (character === ')') {
                parenthesisDepth -= 1;
                continue;
            }

            if (character === '{') {
                if (parenthesisDepth === 0 && angleDepth === 0 && bracketDepth === 0) {
                    const typeBraceEnd = findMatchingBrace(raw, cursor);
                    const afterTypeBrace = typeBraceEnd === -1 ? -1 : skipWhitespaceAndComments(raw, typeBraceEnd + 1);
                    if (afterTypeBrace !== -1 && ['{', '|', '&'].includes(raw[afterTypeBrace])) {
                        cursor = typeBraceEnd;
                        continue;
                    }

                    break;
                }
                braceDepth += 1;
                continue;
            }

            if (character === '}') {
                braceDepth -= 1;
                continue;
            }

            if (character === '[') {
                bracketDepth += 1;
                continue;
            }

            if (character === ']') {
                bracketDepth -= 1;
                continue;
            }

            if (character === '<') {
                angleDepth += 1;
                continue;
            }

            if (character === '>') {
                angleDepth -= 1;
                continue;
            }

            if (
                parenthesisDepth === 0 &&
                braceDepth === 0 &&
                bracketDepth === 0 &&
                angleDepth === 0 &&
                character === ';'
            ) {
                return {
                    returnType: raw.slice(returnTypeStart, cursor).trim(),
                    bodyStart: -1,
                    bodyEnd: -1
                };
            }

            if (
                parenthesisDepth === 0 &&
                braceDepth === 0 &&
                bracketDepth === 0 &&
                angleDepth === 0 &&
                character === '=' &&
                nextCharacter === '>'
            ) {
                break;
            }
        }

        returnType = raw.slice(returnTypeStart, cursor).trim();
        cursor = skipWhitespaceAndComments(raw, cursor);
    }

    if (raw.slice(cursor, cursor + 2) === '=>') {
        cursor += 2;
        cursor = skipWhitespaceAndComments(raw, cursor);
    }

    if (raw[cursor] !== '{') {
        return {
            returnType,
            bodyStart: -1,
            bodyEnd: -1
        };
    }

    const bodyStart = cursor;
    return {
        returnType,
        bodyStart,
        bodyEnd: findMatchingBrace(raw, bodyStart)
    };
}

export function extractFunctionSignatures(raw) {
    const functions = [];
    const signatures = [
        /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
        /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
        /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?\(/g
    ];
    const offsets = lineOffsets(raw);

    for (const signature of signatures) {
        let match;
        while ((match = signature.exec(raw)) !== null) {
            const openParenthesis = match.index + match[0].indexOf('(');
            const parsed = extractParameterList(raw, openParenthesis);
            if (parsed.params === null || parsed.closeIndex === -1) {
                continue;
            }

            const body = extractFunctionBody(raw, parsed.closeIndex);
            const params = splitTopLevelItems(parsed.params);
            functions.push({
                name: match[1],
                params,
                paramCount: params.length,
                line: lineFromOffset(offsets, openParenthesis),
                returnType: body.returnType,
                bodyStart: body.bodyStart,
                bodyEnd: body.bodyEnd
            });
        }
    }

    return functions;
}

export function resolveFunctionNameAtLine(raw, line) {
    const offsets = lineOffsets(raw);
    return extractFunctionSignatures(raw)
        .filter((signature) => {
            const endLine = signature.bodyEnd < 0 ? signature.line : lineFromOffset(offsets, signature.bodyEnd);
            return signature.line <= line && line <= endLine;
        })
        .toSorted((left, right) => right.line - left.line)[0]?.name;
}

export function extractCreateFactories(raw) {
    const factories = [];
    const factoryPattern = /export function\s+(create[A-Z][A-Za-z0-9_]*)\s*\(/g;
    let match;

    while ((match = factoryPattern.exec(raw)) !== null) {
        const paramsStart = match.index + match[0].length;
        let depth = 1;
        let cursor = paramsStart;

        while (cursor < raw.length && depth > 0) {
            if (raw[cursor] === '(') {
                depth += 1;
            }
            else if (raw[cursor] === ')') {
                depth -= 1;
            }
            cursor += 1;
        }

        if (depth !== 0) {
            continue;
        }

        const normalizedParams = raw
            .slice(paramsStart, cursor - 1)
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\r/g, '')
            .replace(/,\s*$/u, '')
            .replace(/\s+/gu, ' ')
            .trim();
        const paramMatch = normalizedParams.match(
            /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([A-Za-z0-9_<>.[\]|&\\s]+)\s*=\s*\{\s*\}$/u
        );
        if (!paramMatch) {
            continue;
        }

        const bodyStart = raw.indexOf('{', cursor);
        const bodyEnd = bodyStart === -1 ? -1 : findMatchingBrace(raw, bodyStart);
        if (bodyStart === -1 || bodyEnd === -1) {
            continue;
        }

        factories.push({
            name: match[1],
            paramName: paramMatch[1],
            paramType: paramMatch[2].trim(),
            bodyStart,
            bodyEnd
        });
    }

    return factories;
}
