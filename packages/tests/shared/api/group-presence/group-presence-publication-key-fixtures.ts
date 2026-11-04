import type { GroupPresencePublicationKey } from '@shared/api/group-types.ts';

/** RFC 7517 Appendix A.1's public key under its RFC 7638 thumbprint; `d` is that appendix's private member. */
export const RFC_7517_PUBLICATION_KEY: GroupPresencePublicationKey = {
    keyId: 'cn-I_WNMClehiVp51i_0VpOENW1upEerA8sEam5hn-s',
    publicJwk: {
        kty: 'EC',
        crv: 'P-256',
        x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
        y: '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM'
    }
};
export const RFC_7517_PRIVATE_D = '870MB6gfuTJ4HtUnUvYMyJpr5eUZNP4Bk43bVdj3eAE';

/** A second generated test key under its RFC 7638 thumbprint, for a heartbeat that rotates the key. */
export const ROTATED_PUBLICATION_KEY: GroupPresencePublicationKey = {
    keyId: 'rZ7cyMEmbfKmfbgktAq0VhUU27CfL9ABhsUWyr3t91o',
    publicJwk: {
        kty: 'EC',
        crv: 'P-256',
        x: 'Nm2QxCrM4kTiPOiaH6lR82miJ0_zi6f1BlvTCNMRV9M',
        y: 'sB_-ygUxxhY4YLuYwL610i1uj3gwJNb1TqhRZ-VuTN8'
    }
};
