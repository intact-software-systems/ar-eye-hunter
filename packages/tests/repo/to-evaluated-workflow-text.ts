const EXPRESSION = /\$\{\{ (.+?) \}\}/gu;
const REFERENCE = /^[a-z]+\.[a-z_]+$/u;
const OPTIONAL_FORMAT = /^([a-z]+\.[a-z_]+) && format\('([^']*)', ([a-z]+\.[a-z_]+)\) \|\| ''$/u;

/**
 * Evaluates the `${{ … }}` expressions of a workflow text the way GitHub does, for the two shapes the ALM lane's names
 * use: a reference such as `matrix.carrier`, and `a && format('…{0}', a) || ''`, which is empty when `a` is. Any other
 * expression, or a reference without a value, throws, so a test built on it fails when the workflow's text changes
 * shape.
 */
export function toEvaluatedWorkflowText(text: string, values: Readonly<Record<string, string>>): string {
    return text.replace(EXPRESSION, (_expressionText, expression: string) => {
        if (REFERENCE.test(expression)) {
            return readReferenceValue(expression, values);
        }
        const optional = OPTIONAL_FORMAT.exec(expression);
        if (optional === null || optional[1] !== optional[3]) {
            throw new Error(`Unsupported workflow expression: ${expression}`);
        }
        const value = readReferenceValue(optional[1], values);
        return value === '' ? '' : optional[2].replaceAll('{0}', value);
    });
}

function readReferenceValue(reference: string, values: Readonly<Record<string, string>>): string {
    const value = values[reference];
    if (value === undefined) {
        throw new Error(`No value for the workflow reference ${reference}`);
    }
    return value;
}
