const AUTH_SECRET_DIGEST_LENGTH = 43;

export function constantTimeAuthDigestEqual(left: string, right: string): boolean {
    let difference = left.length ^ right.length;
    for (let index = 0; index < AUTH_SECRET_DIGEST_LENGTH; index += 1) {
        difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
    }
    return difference === 0;
}
