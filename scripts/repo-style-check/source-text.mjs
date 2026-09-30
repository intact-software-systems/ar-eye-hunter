export function lineOffsets(text) {
    const offsets = [0];
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === '\n') {
            offsets.push(index + 1);
        }
    }

    return offsets;
}

export function lineFromOffset(offsets, index) {
    for (let offsetIndex = 0; offsetIndex < offsets.length; offsetIndex += 1) {
        if (offsetIndex + 1 === offsets.length || index < offsets[offsetIndex + 1]) {
            return offsetIndex + 1;
        }
    }

    return offsets.length;
}

export function skipWhitespaceAndComments(raw, start) {
    let index = start;
    while (index < raw.length) {
        const character = raw[index];
        const nextCharacter = raw[index + 1];

        if (/\s/u.test(character)) {
            index += 1;
            continue;
        }

        if (character === '/' && nextCharacter === '/') {
            index += 2;
            while (index < raw.length && raw[index] !== '\n') {
                index += 1;
            }
            continue;
        }

        if (character === '/' && nextCharacter === '*') {
            index += 2;
            while (index < raw.length - 1) {
                if (raw[index] === '*' && raw[index + 1] === '/') {
                    index += 2;
                    break;
                }
                index += 1;
            }
            continue;
        }

        break;
    }

    return index;
}

export function findMatchingBrace(raw, startIndex) {
    const masked = maskNonCodeText(raw);
    let depth = 0;
    for (let index = startIndex; index < masked.length; index += 1) {
        if (masked[index] === '{') {
            depth += 1;
        }
        else if (masked[index] === '}') {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }

    return -1;
}

export function maskNonCodeLines(lines) {
    return maskNonCodeText(lines.join('\n')).split('\n');
}

export function countMatches(text, pattern) {
    let count = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
        if (match[0].length > 0) {
            count += 1;
        }
    }

    return count;
}

export function splitTopLevelItems(text) {
    const items = [];
    let current = '';
    let parenthesisDepth = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    let angleDepth = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inTemplateQuote = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        const nextCharacter = text[index + 1];

        if (inLineComment) {
            if (character === '\n') {
                inLineComment = false;
            }
            continue;
        }

        if (inBlockComment) {
            if (character === '*' && nextCharacter === '/') {
                inBlockComment = false;
                index += 1;
            }
            continue;
        }

        if (inSingleQuote) {
            if (character === '\\') {
                index += 1;
            }
            else if (character === '\'') {
                inSingleQuote = false;
            }
            continue;
        }

        if (inDoubleQuote) {
            if (character === '\\') {
                index += 1;
            }
            else if (character === '"') {
                inDoubleQuote = false;
            }
            continue;
        }

        if (inTemplateQuote) {
            if (character === '\\') {
                index += 1;
            }
            else if (character === '`') {
                inTemplateQuote = false;
            }
            continue;
        }

        if (character === '/' && nextCharacter === '/') {
            inLineComment = true;
            index += 1;
            continue;
        }

        if (character === '/' && nextCharacter === '*') {
            inBlockComment = true;
            index += 1;
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
            current += character;
            continue;
        }

        if (character === ')') {
            parenthesisDepth -= 1;
            current += character;
            continue;
        }

        if (character === '{') {
            braceDepth += 1;
            current += character;
            continue;
        }

        if (character === '}') {
            braceDepth -= 1;
            current += character;
            continue;
        }

        if (character === '[') {
            bracketDepth += 1;
            current += character;
            continue;
        }

        if (character === ']') {
            bracketDepth -= 1;
            current += character;
            continue;
        }

        if (character === '<') {
            angleDepth += 1;
            current += character;
            continue;
        }

        if (character === '>') {
            angleDepth -= 1;
            current += character;
            continue;
        }

        if (
            character === ',' &&
            parenthesisDepth === 0 &&
            braceDepth === 0 &&
            bracketDepth === 0 &&
            angleDepth === 0
        ) {
            items.push(current.trim());
            current = '';
            continue;
        }

        current += character;
    }

    if (current.trim() !== '') {
        items.push(current.trim());
    }

    return items;
}

const regexAfterCharacter = new Set([
    '\n',
    '(',
    '[',
    '{',
    ',',
    ';',
    ':',
    '=',
    '!',
    '&',
    '|',
    '?',
    '%',
    '^',
    '~',
    '<',
    '>'
]);
const regexAfterIdent = new Set([
    'await',
    'case',
    'delete',
    'do',
    'else',
    'instanceof',
    'of',
    'return',
    'throw',
    'typeof',
    'void',
    'yield'
]);

function maskNonCodeText(text) {
    const state = createCodeMaskState();
    let masked = '';
    let index = 0;
    let lineStart = 0;

    while (index < text.length) {
        if (closeSplitBlockComment(text, index, state)) {
            masked += ' ';
            index += 1;
            continue;
        }
        if (text[index] === '\n') {
            finishMaskLine(text.slice(lineStart, index), state);
            noteCode(state, '\n');
            masked += '\n';
            index += 1;
            lineStart = index;
            continue;
        }
        const step = takeMaskStep(text, index, state);
        masked += step.keep ? text.slice(index, index + step.width) : ' '.repeat(step.width);
        index += step.width;
    }

    finishMaskLine(text.slice(lineStart), state);
    return masked;
}

function createCodeMaskState() {
    return {
        blockStarPending: false,
        ident: '',
        inRegexClass: false,
        lastCode: '\n',
        mode: 'code',
        previousCode: '\n',
        templateDepths: []
    };
}

function closeSplitBlockComment(text, index, state) {
    if (!state.blockStarPending) {
        return false;
    }
    state.blockStarPending = false;
    if (state.mode === 'block' && text[index] === '/') {
        state.mode = 'code';
        return true;
    }
    return false;
}

function finishMaskLine(line, state) {
    state.blockStarPending = state.mode === 'block' && line.endsWith('*');
    if (state.mode !== 'single' && state.mode !== 'double' && state.mode !== 'regex') {
        return;
    }
    if (continuesOnNextLine(line)) {
        return;
    }
    state.inRegexClass = false;
    state.mode = 'code';
}

function continuesOnNextLine(line) {
    let count = 0;
    for (let index = line.length - 1; index >= 0 && line[index] === '\\'; index -= 1) {
        count += 1;
    }
    return count % 2 === 1;
}

function takeMaskStep(text, index, state) {
    if (state.mode === 'single' || state.mode === 'double') {
        return takeStringStep(text, index, state);
    }
    if (state.mode === 'template') {
        return takeTemplateStep(text, index, state);
    }
    if (state.mode === 'block') {
        return takeBlockStep(text, index, state);
    }
    if (state.mode === 'regex') {
        return takeRegexStep(text, index, state);
    }
    return takeCodeStep(text, index, state);
}

function takeStringStep(text, index, state) {
    const character = text[index];
    if (character === '\\' && index + 1 < text.length && text[index + 1] !== '\n') {
        return masked(2);
    }
    const closingQuote = state.mode === 'single' ? '\'' : '"';
    if (character === closingQuote) {
        state.mode = 'code';
    }
    return masked(1);
}

function takeTemplateStep(text, index, state) {
    const character = text[index];
    if (character === '\\' && index + 1 < text.length && text[index + 1] !== '\n') {
        return masked(2);
    }
    if (character === '$' && text[index + 1] === '{') {
        state.templateDepths[state.templateDepths.length - 1] = 1;
        state.mode = 'code';
        return masked(2);
    }
    if (character === '`') {
        state.templateDepths.pop();
        state.mode = 'code';
    }
    return masked(1);
}

function takeBlockStep(text, index, state) {
    if (text[index] === '*' && text[index + 1] === '/') {
        state.mode = 'code';
        state.blockStarPending = false;
        return masked(2);
    }
    return masked(1);
}

function takeRegexStep(text, index, state) {
    const character = text[index];
    if (character === '\\' && index + 1 < text.length && text[index + 1] !== '\n') {
        return masked(2);
    }
    if (character === '[' && !state.inRegexClass) {
        state.inRegexClass = true;
        return masked(1);
    }
    if (character === ']' && state.inRegexClass) {
        state.inRegexClass = false;
        return masked(1);
    }
    if (character === '/' && !state.inRegexClass) {
        state.mode = 'code';
        return masked(1);
    }
    return masked(1);
}

function takeCodeStep(text, index, state) {
    const expressionBrace = takeTemplateExpressionBrace(text[index], state);
    if (expressionBrace !== null) {
        return expressionBrace;
    }
    const character = text[index];
    if (character === '/' && text[index + 1] === '/') {
        return masked(
            text.indexOf('\n', index) === -1
                ? text.length - index
                : text.indexOf('\n', index) - index
        );
    }
    if (character === '/' && text[index + 1] === '*') {
        state.mode = 'block';
        return masked(2);
    }
    if (character === '/' && canStartRegex(state)) {
        state.mode = 'regex';
        state.inRegexClass = false;
        return masked(1);
    }
    if (character === '\'' || character === '"') {
        state.mode = character === '\'' ? 'single' : 'double';
        return masked(1);
    }
    if (character === '`') {
        state.templateDepths.push(0);
        state.mode = 'template';
        return masked(1);
    }
    noteCode(state, character);
    return { keep: true, width: 1 };
}

function takeTemplateExpressionBrace(character, state) {
    const depthIndex = state.templateDepths.length - 1;
    const depth = state.templateDepths[depthIndex];
    if (depth === undefined || depth === 0) {
        return null;
    }
    if (character === '{') {
        state.templateDepths[depthIndex] += 1;
        noteCode(state, character);
        return { keep: true, width: 1 };
    }
    if (character !== '}') {
        return null;
    }
    state.templateDepths[depthIndex] -= 1;
    if (state.templateDepths[depthIndex] === 0) {
        state.mode = 'template';
        return masked(1);
    }
    noteCode(state, character);
    return { keep: true, width: 1 };
}

function canStartRegex(state) {
    if (regexAfterIdent.has(state.ident)) {
        return true;
    }
    if (state.lastCode === '+' || state.lastCode === '-' || state.lastCode === '*') {
        return state.previousCode !== state.lastCode;
    }
    return regexAfterCharacter.has(state.lastCode);
}

function noteCode(state, character) {
    if (character === ' ' || character === '\t') {
        return;
    }
    state.previousCode = state.lastCode;
    state.lastCode = character;
    state.ident = /[A-Za-z0-9_$]/u.test(character) ? `${state.ident}${character}` : '';
}

function masked(width) {
    return { keep: false, width };
}
