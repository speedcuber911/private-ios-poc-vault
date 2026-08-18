package com.parikshit.relay.network

import android.util.Base64
import com.google.crypto.tink.subtle.Ed25519Verify
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.suspendCancellableCoroutine
import live.relay.core.ManifestSignatureEnvelope
import live.relay.core.PocManifest
import live.relay.core.RelayJson
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class AndroidManifestClient(
    private val client: OkHttpClient,
    private val manifestUrl: String,
    private val signatureUrl: String,
) {
    suspend fun fetch(): PocManifest = coroutineScope {
        val manifest = async { fetchBytes(manifestUrl) }
        val signature = async { fetchBytes(signatureUrl) }
        val payload = manifest.await()
        val envelope = RelayJson.decode(
            ManifestSignatureEnvelope.serializer(),
            signature.await().decodeToString(),
        )
        require(envelope.algorithm == null || envelope.algorithm.equals("Ed25519", ignoreCase = true)) {
            "Manifest uses an unsupported signature algorithm."
        }
        val signatureBytes = decodeBase64Url(envelope.signature)
        Ed25519Verify(TRUSTED_PUBLIC_KEY).verify(signatureBytes, payload)
        RelayJson.decode(PocManifest.serializer(), payload.decodeToString())
    }

    private suspend fun fetchBytes(url: String): ByteArray {
        val call = client.newCall(Request.Builder().url(url).get().build())
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(
                object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        if (continuation.isActive) continuation.resumeWithException(e)
                    }

                    override fun onResponse(call: Call, response: Response) {
                        response.use {
                            if (!it.isSuccessful) {
                                if (continuation.isActive) {
                                    continuation.resumeWithException(
                                        IOException("Manifest request failed with HTTP ${it.code}."),
                                    )
                                }
                                return
                            }
                            val bytes = it.body.bytes()
                            if (continuation.isActive) continuation.resume(bytes)
                        }
                    }
                },
            )
        }
    }

    private fun decodeBase64Url(value: String): ByteArray =
        Base64.decode(value, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    companion object {
        private val TRUSTED_PUBLIC_KEY = byteArrayOf(
            0xf9.toByte(), 0xba.toByte(), 0xb6.toByte(), 0x22, 0xa2.toByte(), 0xad.toByte(), 0x92.toByte(), 0xd2.toByte(),
            0x27, 0xeb.toByte(), 0x34, 0x4f, 0xfa.toByte(), 0x99.toByte(), 0x30, 0xb1.toByte(),
            0xaa.toByte(), 0xdf.toByte(), 0x77, 0xee.toByte(), 0xaf.toByte(), 0xb6.toByte(), 0xde.toByte(), 0x82.toByte(),
            0x50, 0xb5.toByte(), 0xc1.toByte(), 0x83.toByte(), 0xfc.toByte(), 0x77, 0x2c, 0xc6.toByte(),
        )
    }
}
