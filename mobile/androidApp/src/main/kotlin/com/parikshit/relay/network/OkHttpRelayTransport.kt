package com.parikshit.relay.network

import com.parikshit.relay.security.AndroidClientIdentityStore
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import live.relay.core.HttpMethod
import live.relay.core.RelayRequest
import live.relay.core.RelayResponse
import live.relay.core.RelayTransport
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.HttpUrl.Companion.toHttpUrl
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class RelayHttpClientFactory(private val identityStore: AndroidClientIdentityStore) {
    fun create(): OkHttpClient {
        val tls = identityStore.tlsMaterial()
        return OkHttpClient.Builder()
            .sslSocketFactory(tls.sslContext.socketFactory, tls.trustManager)
            .callTimeout(java.time.Duration.ofMinutes(5))
            .connectTimeout(java.time.Duration.ofSeconds(15))
            .readTimeout(java.time.Duration.ofMinutes(5))
            .build()
    }
}

class OkHttpRelayTransport(
    baseUrl: String,
    private val client: OkHttpClient,
) : RelayTransport {
    private val baseUrl = baseUrl.trimEnd('/')

    override suspend fun execute(request: RelayRequest): RelayResponse {
        val call = client.newCall(request.toOkHttpRequest())
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(
                object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        if (continuation.isActive) continuation.resumeWithException(e)
                    }

                    override fun onResponse(call: Call, response: Response) {
                        response.use {
                            val body = it.body.string()
                            val headers = it.headers.names().associateWith { name -> it.header(name).orEmpty() }
                            if (continuation.isActive) {
                                continuation.resume(RelayResponse(it.code, body, headers))
                            }
                        }
                    }
                },
            )
        }
    }

    override fun stream(request: RelayRequest): Flow<String> = callbackFlow {
        val call = client.newCall(request.toOkHttpRequest())
        val reader = launch(Dispatchers.IO) {
            try {
                call.execute().use { response ->
                    if (!response.isSuccessful) {
                        error("Relay stream failed with HTTP ${response.code}: ${response.body.string().take(2_048)}")
                    }
                    val source = response.body.source()
                    while (!source.exhausted()) {
                        val line = source.readUtf8Line() ?: break
                        send(line)
                    }
                }
                close()
            } catch (error: Throwable) {
                close(error)
            }
        }
        awaitClose {
            call.cancel()
            reader.cancel()
        }
    }

    private fun RelayRequest.toOkHttpRequest(): Request {
        val url = "$baseUrl$path".toHttpUrl().newBuilder().apply {
            query.forEach { (name, value) -> addQueryParameter(name, value) }
        }.build()
        val body = body?.toRequestBody(JSON) ?: if (method == HttpMethod.POST) EMPTY_JSON else null
        return Request.Builder()
            .url(url)
            .method(method.name, body)
            .header("Accept", accept)
            .apply { if (body != null) header("Content-Type", "application/json") }
            .build()
    }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()
        private val EMPTY_JSON = "{}".toRequestBody(JSON)
    }
}
