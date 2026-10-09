export class InvalidWalletAddressError extends Error {
    constructor() {
        super('Enter a valid Stellar contract wallet address.');
        this.name = 'InvalidWalletAddressError';
    }
}

export class WalletContractNotFoundError extends Error {
    readonly contractAddress: string;

    constructor(readonly address: string) {
        super('This wallet is not deployed on the selected network.');
        this.name = 'WalletContractNotFoundError';
        this.contractAddress = address;
    }
}

export class WalletRecoveryNetworkError extends Error {
    readonly cause?: unknown;

    constructor(readonly address: string, cause?: unknown) {
        super('Could not reach the selected network. Check your connection and try again.');
        this.name = 'WalletRecoveryNetworkError';
        this.cause = cause;
    }
}

export class PasskeyNotRegisteredError extends Error {
    constructor() {
        super('This passkey is not a registered signer on that wallet.');
        this.name = 'PasskeyNotRegisteredError';
    }
}

export class NotVeilWalletError extends Error {
    constructor() {
        super('This deployed contract is not a Veil wallet or has no registered signers.');
        this.name = 'NotVeilWalletError';
    }
}