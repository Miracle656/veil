package xyz.veil.wallet.spp

import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import uniffi.spp_native.ProveOutcome
import uniffi.spp_native.ProveRequest
import uniffi.spp_native.SyncCheckpoint
import uniffi.spp_native.SyncOutcome
import uniffi.spp_native.VerifyOutcome
import uniffi.spp_native.prove
import uniffi.spp_native.syncTo
import uniffi.spp_native.verify
import java.util.concurrent.Executors

/**
 * The Veil SPP native prover, exposed to JS.
 *
 * The Rust crate does the proving; this module is the bridge. Proving is
 * CPU-bound and blocking, so every call dispatches onto a dedicated
 * single-thread executor — never the JS thread, and never the shared
 * Dispatchers.Default pool that UI work also uses (a multi-second proof
 * would otherwise starve it).
 *
 * The Rust surface returns outcome records (result + error_code + detail)
 * rather than raising exceptions, because uniffi error enums cannot carry
 * payloads and the detail is what the UI needs. This module maps outcomes to
 * promise resolve/reject: an outcome with an `error_code` rejects with that
 * code plus its detail; a thrown FFI exception (only possible for a bug,
 * not a caller error) rejects with `E_PROVER`.
 */
class SppNativeModule : Module() {
    // ExecutorCoroutineDispatcher (not the CoroutineDispatcher supertype) so
    // OnDestroy can call close() — close() only exists on the executor subtype.
    private val proverDispatcher: ExecutorCoroutineDispatcher by lazy {
        Executors.newSingleThreadExecutor { r -> Thread(r, "spp-prover") }.asCoroutineDispatcher()
    }

    // The Promise-body AsyncFunction overload runs its lambda as an ordinary
    // function, so the blocking prove/verify/syncTo call cannot use
    // withContext directly; it is launched onto the prover dispatcher through
    // this scope instead, which keeps the work off the JS thread.
    private val proverScope: CoroutineScope by lazy {
        CoroutineScope(proverDispatcher + SupervisorJob())
    }

    override fun definition() = ModuleDefinition {
        Name(SPP_MODULE_NAME)

        AsyncFunction("prove") { request: Map<String, Any?>, promise: Promise ->
            proverScope.launch {
                runCatching { prove(request.toRustProveRequest()) }
                    .onSuccess { outcome -> outcome.resolveOrReject(promise) }
                    .onFailure { promise.reject(E_PROVER, it.message ?: "prover failure", it) }
            }
        }

        AsyncFunction("verify") { proof: ByteArray, publicInputs: ByteArray, promise: Promise ->
            proverScope.launch {
                runCatching { verify(proof, publicInputs) }
                    .onSuccess { outcome -> outcome.resolveOrReject(promise) }
                    .onFailure { promise.reject(E_PROVER, it.message ?: "verify failure", it) }
            }
        }

        AsyncFunction("syncTo") {
                checkpoint: Map<String, Any?>,
                toHeight: Long,
                leaves: List<ByteArray>,
                promise: Promise ->
            proverScope.launch {
                runCatching { syncTo(checkpoint.toRustCheckpoint(), toHeight.toULong(), leaves) }
                    .onSuccess { outcome -> outcome.resolveOrReject(promise) }
                    .onFailure { promise.reject(E_PROVER, it.message ?: "sync failure", it) }
            }
        }

        OnDestroy {
            proverScope.cancel()
            proverDispatcher.close()
        }
    }
}

// Top-level (not in a companion object) so the file's top-level conversion
// helpers below can reference them — a companion member is out of scope
// outside the class body.
private const val E_PROVER = "E_PROVER"
private const val E_BAD_REQUEST = "E_BAD_REQUEST"

// Outcome → promise: an error_code rejects with `code: detail` so the JS
// layer can branch on the prefix without parsing prose. The code is captured
// in a local val first: `errorCode` is a `var` property of the generated
// data class, and Kotlin will not smart-cast a member var to non-null.
private fun ProveOutcome.resolveOrReject(promise: Promise) {
    val code = errorCode
    if (code != null) {
        promise.reject(code, "$code: ${detail.orEmpty()}", null)
    } else {
        promise.resolve(result!!.toJsMap())
    }
}

private fun VerifyOutcome.resolveOrReject(promise: Promise) {
    val code = errorCode
    if (code != null) {
        promise.reject(code, "$code: ${detail.orEmpty()}", null)
    } else {
        promise.resolve(verified)
    }
}

private fun SyncOutcome.resolveOrReject(promise: Promise) {
    val code = errorCode
    if (code != null) {
        promise.reject(code, "$code: ${detail.orEmpty()}", null)
    } else {
        promise.resolve(checkpoint!!.toJsMap())
    }
}

private fun uniffi.spp_native.ProveResult.toJsMap(): Map<String, Any?> = mapOf(
    "proof" to proof,
    "publicInputs" to publicInputs,
    "nativeMs" to nativeMs.toLong(),
)

private fun SyncCheckpoint.toJsMap(): Map<String, Any?> = mapOf(
    "scannedHeight" to scannedHeight.toLong(),
    "commitmentRoot" to commitmentRoot,
    "noteCount" to noteCount.toLong(),
)

// ── Map ⇄ uniffi record conversion ──────────────────────────────────────────
//
// Expo modules receive JS objects as Map<String, Any?>. The conversions below
// are the only place the JS field names and the Rust record fields meet, so
// a mismatch is a single-file fix rather than a cross-repo hunt. Any shape
// error rejects with E_BAD_REQUEST naming the field, so a JS-side typo shows
// up in an error report as the field that was wrong, not a stack trace.

private fun Map<String, Any?>.toRustProveRequest(): ProveRequest {
    val transaction = requireMap("transaction")
    val notes = requireList("notes")
    val paths = requireList("merklePaths")
    val changeNote = requireMap("changeNote")

    return ProveRequest(
        transaction = transaction.toRustTransaction(),
        notes = notes.map { (it as Map<String, Any?>).toRustSpendNote() },
        merklePaths = paths.map { (it as Map<String, Any?>).toRustMerklePath() },
        changeNote = changeNote.toRustOutputNote(),
        blinding = requireByteArray("blinding"),
    )
}

private fun Map<String, Any?>.toRustTransaction() = uniffi.spp_native.SppTransaction(
    anchor = requireByteArray("anchor"),
    inputs = requireList("inputs").map { (it as Map<String, Any?>).toRustInput() },
    outputs = requireList("outputs").map { (it as Map<String, Any?>).toRustOutput() },
    fee = requireLong("fee").toULong(),
    expiryLedger = requireInt("expiryLedger").toUInt(),
)

private fun Map<String, Any?>.toRustInput() = uniffi.spp_native.Input(
    nullifier = requireByteArray("nullifier"),
    leafIndex = requireLong("leafIndex").toULong(),
)

private fun Map<String, Any?>.toRustOutput() = uniffi.spp_native.Output(
    commitment = requireByteArray("commitment"),
    amount = requireLong("amount").toULong(),
    asset = requireString("asset"),
    recipient = requireString("recipient"),
)

private fun Map<String, Any?>.toRustSpendNote() = uniffi.spp_native.SpendNote(
    noteKey = requireByteArray("noteKey"),
    rho = requireByteArray("rho"),
    amount = requireLong("amount").toULong(),
    asset = requireString("asset"),
    commitment = requireByteArray("commitment"),
)

private fun Map<String, Any?>.toRustMerklePath() = uniffi.spp_native.MerklePath(
    depth = requireInt("depth").toUByte(),
    siblings = requireList("siblings").map { it as ByteArray },
    indexBits = requireList("indexBits").map { it as Boolean },
)

private fun Map<String, Any?>.toRustOutputNote() = uniffi.spp_native.OutputNote(
    noteKey = requireByteArray("noteKey"),
    rho = requireByteArray("rho"),
    commitment = requireByteArray("commitment"),
)

private fun Map<String, Any?>.toRustCheckpoint() = SyncCheckpoint(
    scannedHeight = requireLong("scannedHeight").toULong(),
    commitmentRoot = requireByteArray("commitmentRoot"),
    noteCount = requireLong("noteCount").toULong(),
)

// ── Small typed accessors ───────────────────────────────────────────────────

private fun Map<String, Any?>.requireMap(key: String): Map<String, Any?> =
    (this[key] as? Map<String, Any?>)
        ?: throw CodedException(E_BAD_REQUEST, "field '$key' must be an object", null)

private fun Map<String, Any?>.requireList(key: String): List<*> =
    (this[key] as? List<*>)
        ?: throw CodedException(E_BAD_REQUEST, "field '$key' must be an array", null)

private fun Map<String, Any?>.requireByteArray(key: String): ByteArray =
    (this[key] as? ByteArray)
        ?: throw CodedException(E_BAD_REQUEST, "field '$key' must be a byte array", null)

private fun Map<String, Any?>.requireString(key: String): String =
    (this[key] as? String)
        ?: throw CodedException(E_BAD_REQUEST, "field '$key' must be a string", null)

private fun Map<String, Any?>.requireLong(key: String): Long =
    when (val value = this[key]) {
        is Long -> value
        is Int -> value.toLong()
        is Double -> value.toLong()
        else -> throw CodedException(E_BAD_REQUEST, "field '$key' must be a number", null)
    }

private fun Map<String, Any?>.requireInt(key: String): Int = requireLong(key).toInt()
