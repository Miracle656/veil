import { rpc, Keypair, TransactionBuilder, Networks, Operation, xdr } from '@stellar/stellar-sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RPC_URL = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;

async function execute() {
    const server = new rpc.Server(RPC_URL);
    const feePayer = Keypair.random();
    
    console.log("Funding fee-payer with Friendbot:", feePayer.publicKey());
    const friendbotResp = await fetch(`https://friendbot.stellar.org?addr=${feePayer.publicKey()}`);
    if (!friendbotResp.ok) throw new Error("Friendbot funding failed");
    console.log("Friendbot funded successfully.");

    const wasmPath = path.resolve(__dirname, '../contracts/target/wasm32-unknown-unknown/release/multisig_wallet.wasm');
    console.log("Reading WASM from:", wasmPath);
    if (!fs.existsSync(wasmPath)) {
        throw new Error(`WASM file not found at ${wasmPath}`);
    }
    const wasm = fs.readFileSync(wasmPath);

    const account = await server.getAccount(feePayer.publicKey());
    
    console.log("Building upload transaction...");
    const txUpload = new TransactionBuilder(account, { fee: '100000', networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(Operation.uploadContractWasm({
            wasm: wasm
        }))
        .setTimeout(30)
        .build();

    console.log("Simulating transaction...");
    const simReq = await server.simulateTransaction(txUpload);
    if (rpc.Api.isSimulationError(simReq)) {
        console.error("Simulation error details:", simReq);
        throw new Error("Simulation failed");
    }

    console.log("Preparing transaction...");
    const assembledTx = await server.prepareTransaction(txUpload);
    assembledTx.sign(feePayer);
    
    console.log("Submitting transaction to Stellar testnet...");
    const submitReq = await server.sendTransaction(assembledTx);
    console.log("Transaction submitted. Hash:", submitReq.hash);
    
    let wasmId = null;
    let attempts = 0;
    while (attempts < 30) {
        process.stdout.write(".");
        const txResp = await server.getTransaction(submitReq.hash);
        if (txResp.status === "SUCCESS") {
            const meta = txResp.resultMetaXdr;
            let sorobanMeta = null;
            const sw = meta.switch().name;
            console.log("TransactionMeta switch name:", sw);
            if (sw === 'transactionMetaV3') {
                sorobanMeta = meta.v3().sorobanMeta();
            } else if (sw === 'transactionMetaV4') {
                sorobanMeta = meta.v4().sorobanMeta();
            } else {
                console.log("Keys on meta:", Object.keys(meta));
                try {
                    sorobanMeta = meta.v3()?.sorobanMeta();
                } catch (e) {
                    try {
                        sorobanMeta = meta.v4()?.sorobanMeta();
                    } catch (e2) {
                        console.error("Could not extract sorobanMeta:", e, e2);
                    }
                }
            }
            if (sorobanMeta) {
                const scval = sorobanMeta.returnValue();
                wasmId = Buffer.from(scval.bytes()).toString('hex');
            } else {
                throw new Error("Unable to extract sorobanMeta from switch: " + sw);
            }
            break;
        } else if (txResp.status === "FAILED") {
            throw new Error("WASM upload failed on-chain: " + txResp.resultMetaXdr);
        }
        await new Promise(r => setTimeout(r, 1000));
        attempts++;
    }

    if (!wasmId) throw new Error("Wasm ID not found in transaction metadata");
    console.log("\nSuccess!");
    console.log("WASM Uploaded successfully. WASM Hash:", wasmId);
}

execute().catch(console.error);
