import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { FlowBuilderDefinition } from '../../../flow-builder/flow-builder-contracts.ts';

export function decodeFlowBuilderVariablesText(text: string): Either<string, FlowBuilderDefinition['variables']> {
    try {
        const variables = JSON.parse(text);
        return isJsonRecordValue(variables)
            ? Either.ofRight(variables)
            : Either.ofLeft('Variables JSON must be an object.');
    }
    catch (error) {
        return Either.ofLeft(error instanceof Error ? error.message : String(error));
    }
}
