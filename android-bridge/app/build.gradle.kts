npm install -g @openhands/agent-canvasimport java.util.Properties
import java.util.Base64
import java.security.KeyStore

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ca.srclos.schmapsbridge"
    compileSdk = 34

    defaultConfig {
        applicationId = "ca.srclos.schmapsbridge"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "0.1.1"
    }

    signingConfigs {
        create("release") {
            // Filled by the GitHub Actions workflow from repo secrets:
            //   KEYSTORE_BASE64  — base64 of the .jks keystore file
            //   KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD
            // A local.properties fallback (keystore.path etc.) lets you
            // build signed APKs on a machine with Android Studio too.
            val props = Properties()
            val localProps = rootProject.file("local.properties")
            if (localProps.exists()) props.load(localProps.inputStream())

            val ksB64 = System.getenv("KEYSTORE_BASE64") ?: props.getProperty("keystore.base64")
            val ksPath = props.getProperty("keystore.path")
            if (ksB64 != null) {
                // Decode the CI-provided keystore into the build dir.
                // A secret that doesn't decode to a REAL keystore (wrong
                // base64, a text file pasted in, a truncated upload) is
                // treated as absent — the debug-key fallback below still
                // ships an installable APK instead of failing the build.
                val ksFile = layout.buildDirectory.file("ci-keystore.jks").get().asFile
                ksFile.parentFile.mkdirs()
                val ksPass = System.getenv("KEYSTORE_PASSWORD") ?: props.getProperty("keystore.password") ?: ""
                val ksAlias = System.getenv("KEY_ALIAS") ?: props.getProperty("keystore.alias") ?: ""
                try {
                    ksFile.writeBytes(Base64.getDecoder().decode(ksB64))
                    // Validate: a keystore that can't be loaded (or has
                    // no such alias) would only fail later, at packaging.
                    KeyStore.getInstance("JKS").apply {
                        load(ksFile.inputStream(), ksPass.toCharArray())
                        require(ksAlias.isEmpty() || containsAlias(ksAlias))
                    }
                    storeFile = ksFile
                } catch (_: Exception) {
                    logger.warn("ci-keystore invalid — falling back to debug signing")
                    ksFile.delete()
                }
            } else if (ksPath != null) {
                storeFile = rootProject.file(ksPath)
            }
            storePassword = System.getenv("KEYSTORE_PASSWORD") ?: props.getProperty("keystore.password")
            keyAlias = System.getenv("KEY_ALIAS") ?: props.getProperty("keystore.alias")
            keyPassword = System.getenv("KEY_PASSWORD") ?: props.getProperty("keystore.password")
        }
    }

    buildTypes {
        release {
            // Signed with the release key when CI provides the keystore
            // (repo secrets); otherwise falls back to the DEBUG key so
            // the APK is still built, installable and downloadable on
            // every push — signing setup becomes an upgrade, not a
            // prerequisite. (Re-signing with the release key later
            // requires an uninstall, but a missing artifact is worse.)
            signingConfig = if (signingConfigs.getByName("release").storeFile != null) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
}