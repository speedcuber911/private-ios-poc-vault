package com.parikshit.relay.security

import android.content.Context
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import java.io.ByteArrayInputStream
import java.nio.ByteBuffer
import java.security.KeyStore
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

data class ClientIdentity(
    val privateKey: PrivateKey,
    val certificates: List<X509Certificate>,
    val subject: String,
)

data class TlsMaterial(
    val sslContext: SSLContext,
    val trustManager: X509TrustManager,
)

class AndroidClientIdentityStore(private val context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    val hasIdentity: Boolean
        get() = preferences.contains(KEY_CIPHERTEXT) && preferences.contains(KEY_IV)

    fun import(uri: Uri, password: String): String {
        require(password.isNotEmpty()) { "Enter the certificate passphrase." }
        val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
            ?: error("Could not read the selected certificate.")
        require(bytes.isNotEmpty()) { "The selected certificate is empty." }

        val parsed = parsePkcs12(bytes, password.toCharArray())
        val passwordBytes = password.encodeToByteArray()
        val cleartext = ByteBuffer.allocate(Int.SIZE_BYTES + passwordBytes.size + bytes.size)
            .putInt(passwordBytes.size)
            .put(passwordBytes)
            .put(bytes)
            .array()
        passwordBytes.fill(0)
        bytes.fill(0)

        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey())
        val encrypted = cipher.doFinal(cleartext)
        cleartext.fill(0)

        preferences.edit {
            putString(KEY_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            putString(KEY_CIPHERTEXT, Base64.encodeToString(encrypted, Base64.NO_WRAP))
        }
        encrypted.fill(0)
        return parsed.subject
    }

    fun clear() {
        preferences.edit { clear() }
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (keyStore.containsAlias(ENCRYPTION_ALIAS)) keyStore.deleteEntry(ENCRYPTION_ALIAS)
    }

    fun subjectOrNull(): String? = runCatching { loadIdentity().subject }.getOrNull()

    fun loadIdentity(): ClientIdentity {
        val stored = decryptStoredMaterial()
        return try {
            parsePkcs12(stored.pkcs12, stored.password)
        } finally {
            stored.pkcs12.fill(0)
            stored.password.fill('\u0000')
        }
    }

    fun tlsMaterial(): TlsMaterial {
        val stored = decryptStoredMaterial()
        try {
            val keyStore = KeyStore.getInstance("PKCS12").apply {
                load(ByteArrayInputStream(stored.pkcs12), stored.password)
            }
            val keyManagers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
                init(keyStore, stored.password)
            }.keyManagers
            val trustManager = systemTrustManager()
            val context = SSLContext.getInstance("TLS").apply {
                init(keyManagers, arrayOf(trustManager), SecureRandom())
            }
            return TlsMaterial(context, trustManager)
        } finally {
            stored.pkcs12.fill(0)
            stored.password.fill('\u0000')
        }
    }

    private fun decryptStoredMaterial(): StoredMaterial {
        val iv = preferences.getString(KEY_IV, null)?.let { Base64.decode(it, Base64.NO_WRAP) }
            ?: error("Import a client certificate in Settings first.")
        val ciphertext = preferences.getString(KEY_CIPHERTEXT, null)?.let { Base64.decode(it, Base64.NO_WRAP) }
            ?: error("Import a client certificate in Settings first.")
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, encryptionKey(), GCMParameterSpec(128, iv))
        val cleartext = cipher.doFinal(ciphertext)
        val buffer = ByteBuffer.wrap(cleartext)
        val passwordSize = buffer.int
        require(passwordSize in 1..4096 && passwordSize <= buffer.remaining()) { "Stored client identity is invalid." }
        val passwordBytes = ByteArray(passwordSize).also(buffer::get)
        val pkcs12 = ByteArray(buffer.remaining()).also(buffer::get)
        val password = passwordBytes.decodeToString().toCharArray()
        passwordBytes.fill(0)
        cleartext.fill(0)
        return StoredMaterial(pkcs12, password)
    }

    private fun parsePkcs12(bytes: ByteArray, password: CharArray): ClientIdentity {
        val keyStore = KeyStore.getInstance("PKCS12").apply {
            load(ByteArrayInputStream(bytes), password)
        }
        val alias = keyStore.aliases().toList().firstOrNull { keyStore.isKeyEntry(it) }
            ?: error("The PKCS#12 file does not contain a client private key.")
        val key = keyStore.getKey(alias, password) as? PrivateKey
            ?: error("The PKCS#12 client key could not be loaded.")
        val certificates = keyStore.getCertificateChain(alias)
            ?.mapNotNull { it as? X509Certificate }
            .orEmpty()
        require(certificates.isNotEmpty()) { "The PKCS#12 file does not contain a certificate chain." }
        certificates.first().checkValidity()
        return ClientIdentity(key, certificates, certificates.first().subjectX500Principal.name)
    }

    private fun encryptionKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(ENCRYPTION_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    ENCRYPTION_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            generateKey()
        }
    }

    private fun systemTrustManager(): X509TrustManager {
        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
            init(null as KeyStore?)
        }
        return factory.trustManagers.filterIsInstance<X509TrustManager>().single()
    }

    private data class StoredMaterial(val pkcs12: ByteArray, val password: CharArray)

    companion object {
        private const val PREFERENCES = "relay.client.identity"
        private const val KEY_IV = "iv"
        private const val KEY_CIPHERTEXT = "ciphertext"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val ENCRYPTION_ALIAS = "relay.client.identity.encryption"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
