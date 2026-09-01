// deno-lint-ignore-file no-explicit-any
import { withExtractedOutputs } from './black-box-output-transform.ts';

const FAILURE = 'FAILURE';

export function toResultKey(interactionData: any): string {
    return [
        interactionData.name,
        'i' + interactionData.interactionExecutionNumber,
        interactionData.repeatIndex !== undefined ? 'r' + interactionData.repeatIndex : undefined
    ]
        .filter((value) => value !== undefined && value !== null && value !== '')
        .join('-');
}

export function storeInteractionData(interactionData: any, context: any): any {
    if (!interactionData || !interactionData.name) {
        return interactionData;
    }

    const resultKey = toResultKey(interactionData);

    const resultWithKey = withExtractedOutputs({
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

    if (!context.resultsByName[interactionData.name]) {
        context.resultsByName[interactionData.name] = [];
    }

    context.resultsByName[interactionData.name].push(storedResult);

    return storedResult;
}
