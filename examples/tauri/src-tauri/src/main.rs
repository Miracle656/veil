#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::ecdsa::{signature::hazmat::PrehashSigner, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use tauri::{command, AppHandle};

#[derive(Deserialize)]
struct RegisterPasskeyArgs {
    rpId: String,
    rpName: String,
    userId: String,
    userName: String,
    challenge: String,
}

#[derive(Serialize)]
struct RegisterPasskeyResponse {
    credentialId: String,
    publicKeyBytes: String,
}

#[derive(Deserialize)]
struct SignWithPasskeyArgs {
    credentialId: String,
    challenge: String,
    rpId: String,
    origin: String,
}

#[derive(Serialize)]
struct SignWithPasskeyResponse {
    authData: String,
    clientDataJSON: String,
    signature: String,
}

#[derive(Serialize, Deserialize)]
struct CredentialMetadata {
    credentialId: String,
    rpId: String,
    rpName: String,
    userId: String,
    userName: String,
    origin: String,
}

fn storage_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path_resolver()
        .app_dir()
        .ok_or_else(|| "Unable to resolve application directory".to_string())?
        .join("veil-passkey")
    
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn credential_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(storage_dir(app)?.join("credential.json"))
}

fn private_key_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(storage_dir(app)?.join("private_key.bin"))
}

fn decode_base64url(value: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|e| format!("Invalid base64url: {e}"))
}

fn encode_base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

#[command]
fn register_passkey(app: AppHandle, args: RegisterPasskeyArgs) -> Result<RegisterPasskeyResponse, String> {
    let user_id = decode_base64url(&args.userId)?;
    let challenge = decode_base64url(&args.challenge)?;

    let signing_key = SigningKey::random(&mut OsRng);
    let secret_bytes = signing_key.to_bytes();
    let public_key_bytes = signing_key
        .verifying_key()
        .to_encoded_point(false)
        .as_bytes()
        .to_vec();

    let mut credential_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut credential_bytes);
    let credential_id = encode_base64url(&credential_bytes);
    let metadata = CredentialMetadata {
        credentialId: credential_id.clone(),
        rpId: args.rpId,
        rpName: args.rpName,
        userId: encode_base64url(&user_id),
        userName: args.userName,
        origin: String::new(),
    };

    fs::write(private_key_file(&app)?, secret_bytes.as_slice()).map_err(|e| e.to_string())?;
    fs::write(credential_file(&app)?, serde_json::to_vec(&metadata).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    Ok(RegisterPasskeyResponse {
        credentialId: credential_id,
        publicKeyBytes: encode_base64url(&public_key_bytes),
    })
}

fn load_signing_key(path: &PathBuf) -> Result<SigningKey, String> {
    let secret_bytes = fs::read(path).map_err(|e| e.to_string())?;
    if secret_bytes.len() != 32 {
        return Err("Private key must be 32 bytes".to_string());
    }
    let secret_array: [u8; 32] = secret_bytes
        .as_slice()
        .try_into()
        .map_err(|_| "Invalid private key length".to_string())?;
    SigningKey::from_bytes(&secret_array).map_err(|e| e.to_string())
}

#[command]
fn sign_with_passkey(app: AppHandle, args: SignWithPasskeyArgs) -> Result<SignWithPasskeyResponse, String> {
    let metadata: CredentialMetadata = serde_json::from_slice(
        &fs::read(credential_file(&app)?,).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    if metadata.credentialId != args.credentialId {
        return Err("Credential ID not found".to_string());
    }

    let signing_key = load_signing_key(&private_key_file(&app)?)?;
    let challenge = decode_base64url(&args.challenge)?;

    let rp_id_hash = Sha256::digest(args.rpId.as_bytes());
    let mut auth_data = [0u8; 37];
    auth_data[..32].copy_from_slice(&rp_id_hash);
    auth_data[32] = 0x05;
    auth_data[33..37].copy_from_slice(&0u32.to_be_bytes());

    let client_data_json = serde_json::json!({
        "type": "webauthn.get",
        "challenge": encode_base64url(&challenge),
        "origin": args.origin,
        "crossOrigin": false,
    });
    let client_data_json_bytes = serde_json::to_vec(&client_data_json).map_err(|e| e.to_string())?;

    let client_data_hash = Sha256::digest(&client_data_json_bytes);
    let mut message = Vec::with_capacity(auth_data.len() + client_data_hash.len());
    message.extend_from_slice(&auth_data);
    message.extend_from_slice(&client_data_hash);
    let message_hash = Sha256::digest(&message);

    let signature = signing_key
        .sign_prehash(&message_hash)
        .map_err(|e| e.to_string())?;
    let signature_bytes: [u8; 64] = signature.to_bytes().into();

    Ok(SignWithPasskeyResponse {
        authData: encode_base64url(&auth_data),
        clientDataJSON: encode_base64url(&client_data_json_bytes),
        signature: encode_base64url(&signature_bytes),
    })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_biometric::init())
        .invoke_handler(tauri::generate_handler![register_passkey, sign_with_passkey])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
