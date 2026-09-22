import type {
    RallarBlackBoxTestHttpRequestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecord
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { json } from '../../shared/json-presentation.ts';

export interface AuthCommandCenterRecipeInput {
    readonly username: string;
    createRequestId(): string;
}

export function toAuthCommandCenterRecipeText({ username, createRequestId }: AuthCommandCenterRecipeInput): string {
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'rallar-auth-command-center',
        name: 'Rallar auth command-center recipe',
        continueOnFailure: true,
        commands: [
            toAuthHttpCommand(
                'auth-login',
                `/api/auth/login/requests/${createRequestId()}`,
                { username: username || '<username>', password: '<password>' }
            ),
            toAuthHttpCommand('auth-ws-ticket', `/api/auth/ws-ticket/requests/${createRequestId()}`, {}),
            {
                ...toAuthHttpCommand(
                    'auth-missing-token-negative',
                    `/api/auth/ws-ticket/requests/${createRequestId()}`,
                    {}
                ),
                metadata: {
                    expectedStatus: 401
                }
            }
        ]
    };
    return json(recipe);
}

function toAuthHttpCommand(
    commandId: string,
    path: string,
    body: RallarBlackBoxTestRecord
): RallarBlackBoxTestHttpRequestCommand {
    return {
        kind: 'http.request',
        commandId,
        request: {
            path,
            method: 'POST',
            body
        },
        response: {
            body: 'json'
        }
    };
}
