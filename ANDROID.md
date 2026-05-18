# AgarJMR — Android (Capacitor)

Este proyecto incluye una wrapper Android nativa generada con [Capacitor](https://capacitorjs.com).

## Identidad de la app

| Campo | Valor |
|---|---|
| Nombre | AgarJMR |
| Application ID | `app.kadenas.agariojmr` |
| versionName | `1.0.0` |
| versionCode | `10000` |
| minSdk | 29 (Android 10) |
| targetSdk | 35 (Android 15) |

## Servidor de juego

La app, una vez instalada en el móvil, se conecta al servidor de Railway en producción:

```
wss://agario-jmr-production.up.railway.app
```

Los jugadores de Web + Android comparten el mismo servidor, así que se ven en la misma partida.

## Compilar el APK debug (en tu máquina)

### Prerrequisitos
1. **Android Studio**: https://developer.android.com/studio (incluye SDK + emulador)
2. **JDK 17 o superior** (ya tienes Java 21)
3. **Dispositivo Android** con depuración USB activada, o emulador

### Pasos

1. Sincroniza assets cada vez que cambies algo del front:
   ```bash
   npx cap sync android
   ```

2. Abre el proyecto en Android Studio:
   ```bash
   npx cap open android
   ```
   (Esto abre `android/` como proyecto)

3. En Android Studio: `Build → Build Bundle(s) / APK(s) → Build APK(s)`.
   El APK debug se genera en:
   ```
   android/app/build/outputs/apk/debug/app-debug.apk
   ```

4. Para instalar en tu móvil (USB):
   ```bash
   adb install android/app/build/outputs/apk/debug/app-debug.apk
   ```

## Compilar para Play Store (release)

1. **Generar keystore** (una sola vez, guarda este archivo en lugar seguro):
   ```bash
   keytool -genkey -v -keystore agarjmr-release.jks \
     -keyalg RSA -keysize 2048 -validity 10000 -alias agarjmr
   ```
   Te pedirá contraseñas. Apúntalas.

2. **Configurar firma**: añade a `android/app/build.gradle` dentro de `android { ... }`:
   ```gradle
   signingConfigs {
       release {
           storeFile file("../../agarjmr-release.jks")
           storePassword "TU_STORE_PASSWORD"
           keyAlias "agarjmr"
           keyPassword "TU_KEY_PASSWORD"
       }
   }
   buildTypes {
       release {
           signingConfig signingConfigs.release
           minifyEnabled false
       }
   }
   ```
   (Mejor leer las contraseñas de variables de entorno o un `keystore.properties`, no commitear)

3. **Build → Generate Signed Bundle / APK** en Android Studio. Elige **Android App Bundle (.aab)** (formato exigido por Play Store).

   Output:
   ```
   android/app/release/app-release.aab
   ```

## Subir a Play Console

1. Crear cuenta en https://play.google.com/console (25 USD una vez)
2. Crear app nueva, rellenar:
   - Nombre, descripción corta (80 chars), descripción larga (4000 chars)
   - Icono 512×512 PNG
   - Feature graphic 1024×500 PNG
   - Mínimo 2 screenshots de móvil
   - Cuestionario de clasificación de contenido
   - Formulario de seguridad de datos
   - URL de política de privacidad
3. Subir el `.aab` a **Testing → Internal testing** primero
4. Cuando funcione, promover a **Production**

## Estructura

```
android/                  # Proyecto Android Studio
├── app/
│   ├── build.gradle      # versionCode, versionName, SDKs
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── assets/public/  # Copia de la web (sincronizada con cap sync)
│       └── res/
│           ├── mipmap-*/   # Iconos de app
│           └── drawable-*/  # Splash screens
└── variables.gradle      # Versiones de SDK compartidas
```

## Para futuras releases

1. Hacer cambios en `public/` (la web)
2. Subir versionCode (`versionCode 10001`, etc) y versionName en `android/app/build.gradle`
3. `npx cap sync android`
4. Compilar release AAB
5. Subir a Play Console
