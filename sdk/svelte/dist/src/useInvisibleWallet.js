import { useState, useEffect, useMemo } from 'react';
import { InvisibleWalletCore, } from './InvisibleWalletCore';
export * from './InvisibleWalletCore';
export function useInvisibleWallet(config) {
    // String configurations are handled inside InvisibleWalletCore.
    // Memoize the core instance based on the configuration parameters.
    const configKey = typeof config === 'string'
        ? config
        : `${config.factoryAddress}-${config.rpcUrl}-${config.networkPassphrase}-${config.rpId ?? ''}-${config.origin ?? ''}`;
    const core = useMemo(() => new InvisibleWalletCore(config), [configKey]);
    const [state, setState] = useState(core.getState());
    useEffect(() => {
        return core.subscribe(setState);
    }, [core]);
    return useMemo(() => ({
        address: state.address,
        isDeployed: state.isDeployed,
        isPending: state.isPending,
        error: state.error,
        register: core.register.bind(core),
        deploy: core.deploy.bind(core),
        login: core.login.bind(core),
        signAuthEntry: core.signAuthEntry.bind(core),
        getNonce: core.getNonce.bind(core),
        addSigner: core.addSigner.bind(core),
        removeSigner: core.removeSigner.bind(core),
        getSigners: core.getSigners.bind(core),
        setGuardian: core.setGuardian.bind(core),
        initiateRecovery: core.initiateRecovery.bind(core),
        completeRecovery: core.completeRecovery.bind(core),
        approve: core.approve.bind(core),
        getAllowance: core.getAllowance.bind(core),
    }), [state, core]);
}
