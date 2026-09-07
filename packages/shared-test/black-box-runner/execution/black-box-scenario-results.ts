import { withExtractedOutputs } from './black-box-output-transform.ts';

export interface InteractionResult {
    readonly name: string;
    readonly status: string;
    readonly interactionExecutionNumber?: number;
    readonly repeatIndex?: number;
    readonly nonBlockingFailure?: boolean;
    readonly interaction?: { readonly request?: { readonly nonBlockingFailure?: boolean; }; };
    readonly [field: string]: unknown;
}

export interface StoredInteractionResult extends InteractionResult {
    readonly resultKey: string;
}

interface InteractionResultStore {
    readonly results: Record<string, StoredInteractionResult>;
    readonly resultsList: StoredInteractionResult[];
    readonly resultsByName: Record<string, StoredInteractionResult[]>;
}

interface InteractionOutputFields {
    readonly output?: unknown;
    readonly outputPath?: unknown;
    readonly outputs?: unknown;
    readonly transform?: unknown;
    readonly secret?: unknown;
    readonly redact?: unknown;
    readonly redactAs?: unknown;
}

const FAILURE = 'FAILURE';

export function toResultKey(interactionData: InteractionResult): string {
    return [
        interactionData.name,
        'i' + interactionData.interactionExecutionNumber,
        interactionData.repeatIndex !== undefined ? 'r' + interactionData.repeatIndex : undefined
    ]
        .filter((value) => value !== undefined && value !== null && value !== '')
        .join('-');
}

export function storeInteractionData(
    interactionData: InteractionResult,
    context: InteractionResultStore
): InteractionResult {
    if (!interactionData || !interactionData.name) {
        return interactionData;
    }

    const resultKey = toResultKey(interactionData);

    const resultWithKey: StoredInteractionResult = withExtractedOutputs({
        ...interactionData,
        resultKey
    }, context);
    const storedResult = resultWithKey?.status === FAILURE &&
            (resultWithKey?.nonBlockingFailure === true ||
                resultWithKey?.interaction?.request?.nonBlockingFailure === true)
        ? {
            ...resultWithKey,
            nonBlockingFailure: true
        }
        : resultWithKey;

    context.results[resultKey] = storedResult;
    context.resultsList.push(storedResult);

    appendInteractionResultByName(context.resultsByName, storedResult);

    return storedResult;
}

export function toInteractionOutputFields<T extends InteractionOutputFields>(
    interaction: { readonly request: T; }
): Pick<T, keyof InteractionOutputFields> {
    return {
        output: interaction.request.output,
        outputPath: interaction.request.outputPath,
        outputs: interaction.request.outputs,
        transform: interaction.request.transform,
        secret: interaction.request.secret,
        redact: interaction.request.redact,
        redactAs: interaction.request.redactAs
    };
}

function appendInteractionResultByName<T extends InteractionResult>(byName: Record<string, T[]>, result: T): void {
    if (Object.hasOwn(byName, result.name)) {
        byName[result.name].push(result);
        return;
    }
    Object.defineProperty(byName, result.name, {
        value: [result],
        enumerable: true,
        writable: true,
        configurable: true
    });
}

export function groupInteractionResultsByName<T extends InteractionResult>(results: readonly T[]): Record<string, T[]> {
    const byName: Record<string, T[]> = Object.create(null);
    for (const result of results) {
        appendInteractionResultByName(byName, result);
    }
    return byName;
}
