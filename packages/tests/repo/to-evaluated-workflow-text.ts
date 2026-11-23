const EXPRESSION = /\$\{\{\s*(.+?)\s*\}\}/gu;
const REFERENCE = /^[a-z]+\.[a-z_]+$/u;
const OPTIONAL_FORMAT = /^([a-z]+\.[a-z_]+) && format\('([^']*)', ([a-z]+\.[a-z_]+)\) \|\| ''$/u;

/** A composite action's input as its `action.yml` declares it. */
export interface WorkflowActionInput {
    readonly default?: string;
}

/**
 * Evaluates the `${{ … }}` expressions of a workflow text the way GitHub does, for the two shapes the ALM lane's names
 * use: a reference such as `matrix.carrier`, and `a && format('…{0}', a) || ''`, which is empty when `a` is. Any other
 * expression, a reference without a value, or a `${{` left unevaluated throws, so a test built on it fails when the
 * workflow's text changes shape.
 */
export function toEvaluatedWorkflowText(text: string, values: Readonly<Record<string, string>>): string {
    const evaluated = text.replace(EXPRESSION, (_expressionText, expression: string) => {
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
    if (evaluated.includes('${{')) {
        throw new Error(`Unevaluated workflow expression in ${text}`);
    }
    return evaluated;
}

/**
 * The `inputs.<name>` values an action receives from a step's `with`, each evaluated against the calling job's
 * values; an input the step does not pass takes its declared default.
 */
export function toEvaluatedActionInputs(
    inputs: Readonly<Record<string, WorkflowActionInput>>,
    given: Readonly<Record<string, string | number>>,
    values: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
    return Object.fromEntries(
        Object.entries(inputs).map(([input, declaration]) => {
            const passed = given[input];
            const text = passed === undefined ? declaration.default : String(passed);
            if (text === undefined) {
                throw new Error(`No value for the action input ${input}`);
            }
            return [`inputs.${input}`, toEvaluatedWorkflowText(text, values)];
        })
    );
}

function readReferenceValue(reference: string, values: Readonly<Record<string, string>>): string {
    const value = values[reference];
    if (value === undefined) {
        throw new Error(`No value for the workflow reference ${reference}`);
    }
    return value;
}
