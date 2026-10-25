import java.util.Properties

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
        versionCode = 1
        versionName = "0.1.0"
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
                val ksFile = layout.buildDirectory.file("ci-keystore.jks").get().asFile
                ksFile.parentFile.mkdirs()
                ksFile.writeBytes(java.util.Base64.getDecoder().decode(ksB64))
                storeFile = ksFile
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
            signingConfig = signingConfigs.getByName("release")
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