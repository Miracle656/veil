import { rpc, Keypair, Contract, xdr, TransactionBuilder, Networks, StrKey, Operation } from 'stellar-sdk';
import fs from 'fs';

const RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;

async function execute() {
    const server = new rpc.Server(RPC_URL, { allowHttp: true });
    const feePayer = Keypair.random();
    
    console.log("Funding fee-payer:", feePayer.publicKey());
    const friendbotResp = await fetch(`https://friendbot.stellar.org?addr=${feePayer.publicKey()}`);
    if (!friendbotResp.ok) throw new Error("Friendbot funding failed");

    console.log("Reading WASM...");
    const wasm = fs.readFileSync('../contracts/invisible_wallet/target/wasm32-unknown-unknown/release/invisible_wallet.wasm');

    const account = await server.getAccount(feePayer.publicKey());
    
    console.log("Uploading WASM...");
    let txUpload = new TransactionBuilder(account, { fee: '100000', networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(Operation.uploadContractWasm({
            wasm: wasm
        }))
        .setTimeout(30)
        .build();

    let simReq = await server.simulateTransaction(txUpload);
    if (rpc.Api.isSimulationError(simReq)) {
        fs.writeFileSync('error.json', JSON.stringify(simReq, null, 2));
        throw new Error("Simulation failed, see error.json");
    }
    let assembledTx = await server.prepareTransaction(txUpload);
    assembledTx.sign(feePayer);
    let submitReq = await server.sendTransaction(assembledTx);
    
    let wasmId;
    let attempts = 0;
    while (attempts < 20) {
        const txResp = await server.getTransaction(submitReq.hash);
        if (txResp.status === "SUCCESS") {
            const resultMetaXdr = txResp.resultMetaXdr;
            const meta = xdr.TransactionMeta.fromXDR(resultMetaXdr, 'base64');
            const scval = meta.v3().sorobanMeta().returnValue();
            wasmId = Buffer.from(scval.bytes()).toString('hex');
            break;
        } else if (txResp.status === "FAILED") {
            throw new Error("WASM upload failed: " + txResp.resultMetaXdr);
        }
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
    }

    if (!wasmId) throw new Error("Wasm ID not found");
    console.log("WASM Uploaded:", wasmId);

    const feePayerKeyPkt = xdr.PublicKey.publicKeyTypeEd25519(feePayer.rawPublicKey());
    const accountId = new xdr.AccountId(feePayerKeyPkt);
    const createOp = Operation.createCustomContract({
        address: feePayer.publicKey(),
        wasmId: wasmId
    });

    console.log("Deploying Contract...");
    let txDeploy = new TransactionBuilder(await server.getAccount(feePayer.publicKey()), { fee: '100000', networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(createOp)
        .setTimeout(30)
        .build();

    let assembledDeploy = await server.prepareTransaction(txDeploy);
    assembledDeploy.sign(feePayer);
    let submitDeploy = await server.sendTransaction(assembledDeploy);

    attempts = 0;
    let contractId;
    while (attempts < 20) {
        const txResp = await server.getTransaction(submitDeploy.hash);
        if (txResp.status === "SUCCESS") {
            const meta = xdr.TransactionMeta.fromXDR(txResp.resultMetaXdr, 'base64');
            const scval = meta.v3().sorobanMeta().returnValue();
            // Assuming output is the contract ID address
            contractId = StrKey.encodeContract(scval.address().contractId());
            break;
        }
        await new Promise(r => setTimeout(r, 2000));
        attempts++;
    }

    if (!contractId) throw new Error("Contract ID not found");
    console.log("Deployed Factory Contract:", contractId);
    
    const envLocal = `NEXT_PUBLIC_FACTORY_ADDRESS=${contractId}\nNEXT_PUBLIC_RPC_URL=https://soroban-testnet.stellar.org\nNEXT_PUBLIC_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"`;
    fs.writeFileSync('.env.local', envLocal);
    console.log("Updated .env.local with new Factory Address.");
}

execute().catch(console.error);
