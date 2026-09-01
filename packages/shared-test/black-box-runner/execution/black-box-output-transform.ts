// deno-lint-ignore-file no-explicit-any
import {
    directSafeOutputTransformSpec,
    evaluateSafeOutputTransform,
    SafeOutputTransformError
} from '../scenario-transform/safe-output-transform.ts';
import { addRedaction, isRecord } from './black-box-redaction.ts';
import { randomUuid } from './black-box-run-correlation.ts';
import { toResolverRoot, tryResolvePath } from './black-box-value-resolution.ts';

const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';

function extractOutputPath(result: any, outputPath: any): any {
    if (outputPath === undefined || outputPath === null || outputPath === '') {
        return result.actual;
    }

    if (typeof outputPath !== 'string') {
        throw new Error('Output path must be a string');
    }

    const roots = [
        result,
        result?.actual,
        result?.actual?.body
    ];

    for (const root of roots) {
        const resolved = tryResolvePath(outputPath, root);
        if (resolved.found) {
            return resolved.value;
        }
    }

    throw new Error('Cannot resolve output path {' + outputPath + '}');
}

interface OutputExtraction {
    name: string;
    path?: any;
    transform?: any;
    secret?: boolean;
    redactAs?: string;
}

interface EvaluateScenarioTransformInput {
    readonly transform: any;
    readonly context: any;
    readonly result?: any;
    readonly operatorPath?: string;
}

export function evaluateScenarioTransform(input: EvaluateScenarioTransformInput): any {
    return evaluateSafeOutputTransform(input.transform, {
        resolverRoot: toResolverRoot(input.context),
        result: input.result,
        operatorPath: input.operatorPath,
        createUuid: randomUuid,
        readTimestamp: Date.now
    });
}

function outputExtractions(result: any): OutputExtraction[] {
    const extractions: OutputExtraction[] = [];

    if (typeof result.output === 'string' && result.output.length > 0) {
        extractions.push({
            name: result.output,
            path: result.outputPath,
            transform: result.transform,
            secret: result.secret === true || result.redact === true,
            redactAs: typeof result.redactAs === 'string' ? result.redactAs : undefined
        });
    }

    if (isRecord(result.outputs)) {
        Object.entries(result.outputs).forEach(([name, spec]) => {
            if (typeof spec === 'string') {
                extractions.push({
                    name,
                    path: spec
                });
                return;
            }

            if (isRecord(spec)) {
                extractions.push({
                    name,
                    path: spec.path ?? spec.from ?? spec.outputPath,
                    transform: spec.transform ?? directSafeOutputTransformSpec(spec),
                    secret: spec.secret === true || spec.redact === true,
                    redactAs: typeof spec.redactAs === 'string' ? spec.redactAs : undefined
                });
                return;
            }

            extractions.push({
                name,
                path: spec
            });
        });
    }

    return extractions;
}

export function withExtractedOutputs(result: any, context: any): any {
    if (result?.status !== SUCCESS) {
        return result;
    }

    const extractions = outputExtractions(result);
    if (extractions.length <= 0) {
        return result;
    }

    const extractionErrors: any[] = [];
    const extractedOutputs: Array<OutputExtraction & { value: any; }> = [];

    extractions.forEach((extraction) => {
        try {
            const value = extraction.transform !== undefined
                ? evaluateScenarioTransform({
                    transform: extraction.transform,
                    context,
                    result,
                    operatorPath: `outputs.${extraction.name}`
                })
                : extractOutputPath(result, extraction.path);
            extractedOutputs.push({
                ...extraction,
                value
            });
        }
        catch (error) {
            extractionErrors.push({
                output: extraction.name,
                path: extraction.path,
                transform: extraction.transform,
                error: error instanceof Error ? error.message : String(error),
                details: error instanceof SafeOutputTransformError ? error.details : undefined
            });
        }
    });

    if (extractionErrors.length <= 0) {
        extractedOutputs.forEach((extraction) => {
            context.outputs[extraction.name] = extraction.value;
            if (extraction.secret) {
                addRedaction(context.redactions, extraction.redactAs || extraction.name, extraction.value);
            }
        });

        return result;
    }

    return {
        ...result,
        status: FAILURE,
        result: 'Output extraction failed',
        details: {
            ...(isRecord(result.details) ? result.details : {}),
            outputExtractionErrors: extractionErrors
        }
    };
}
