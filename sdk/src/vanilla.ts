import {
    Account,
    Address,
    Contract,
    rpc as SorobanRpc,
    Horizon,
    StrKey,
    TransactionBuilder,
    BASE_FEE,
    xdr,
    nativeToScVal,
    scValToNative,
    Networks,
} from '@stellar/stellar-sdk';