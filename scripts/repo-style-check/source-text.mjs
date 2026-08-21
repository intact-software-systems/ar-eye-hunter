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
    let depth = 0;
    for (let index = startIndex; index < raw.length; index += 1) {
        if (raw[index] === '{') {
            depth += 1;
        }
        else if (raw[index] === '}') {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }

    return -1;
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
