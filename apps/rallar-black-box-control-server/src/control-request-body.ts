export type ControlJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly ControlJsonValue[]
    | { readonly [key: string]: ControlJsonValue; };

export class PayloadTooLargeError extends Error {}

export interface ControlRequestBodyReader {
    assertPayloadByteLength(byteLength: number): void;
    readJsonBody(request: Request, allowEmpty?: boolean): Promise<ControlJsonValue>;
}

export function createControlRequestBodyReader(maxRequestBytes: number): ControlRequestBodyReader {
    function assertPayloadByteLength(byteLength: number): void {
        if (byteLength > maxRequestBytes) {
            throw new PayloadTooLargeError(
                `Request payload is too large: ${byteLength} bytes exceeds ${maxRequestBytes} bytes.`
            );
        }
    }

    async function readTextBody(request: Request): Promise<string> {
        const declaredLength = request.headers.get('content-length');
        if (declaredLength) {
            const parsed = Number.parseInt(declaredLength, 10);
            if (Number.isFinite(parsed)) {
                assertPayloadByteLength(parsed);
            }
        }

        const reader = request.body?.getReader();
        if (!reader) {
            return '';
        }

        const decoder = new TextDecoder();
        let byteLength = 0;
        let text = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            byteLength += value.byteLength;
            assertPayloadByteLength(byteLength);
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return text;
    }

    return {
        assertPayloadByteLength,
        async readJsonBody(request, allowEmpty = false) {
            const text = await readTextBody(request);
            if (text.length === 0 && allowEmpty) {
                return {};
            }

            return JSON.parse(text) as ControlJsonValue;
        }
    };
}
