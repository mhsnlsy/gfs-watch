# İstanbul'un Havası — Android

This branch adds a native Android companion app around the existing website.

## What is included

- Capacitor 8 Android shell. The website is bundled from `site/`; forecast and station data continue to come from the deployed Pages JSON endpoints.
- A native 2×2 home-screen widget and a native 4×2 widget (Android AppWidget / RemoteViews).
- WorkManager refresh scheduling (15-minute periodic minimum) for widget data and rain-alert checks.
- Rain alerts for fresh MGM station observations and near-term GFS forecast precipitation. Android notification permission is requested at first launch.
- A native JSON cache shared by the website, widget worker and offline fallback.

The app deliberately uses the existing published data contract. It does not introduce another GFS source: forecast data remains the current GFS Watch output.

## Build locally

Requirements: Node.js 22+, Android Studio with Android SDK Platform 36, and JDK 21.

```bash
npm install
npx cap add android
npm run android:prepare
npx cap sync android
npx cap open android
```

Build a debug APK from a terminal:

```bash
cd android
./gradlew assembleDebug
```

APK path: `android/app/build/outputs/apk/debug/app-debug.apk`.

## Automatic APK build

Every push to `android-capacitor` runs the Android workflow. The debug APK is uploaded as a GitHub Actions artifact named `istanbul-hava-debug-apk`.

## First phone test

1. Download the APK artifact from the latest successful **Build Android APK** workflow run.
2. Install it on the Samsung phone. Android may ask to allow installation from the browser or file manager used to open the APK.
3. Open the app once while online and allow notifications.
4. Long-press the home screen, open **Widgets**, find **İstanbul'un Havası**, and add both widget sizes.
5. Turn off Wi-Fi/mobile data briefly. The app should show its last cached data; the widget should keep its last successful values.
6. Restore internet. The worker will refresh on its next scheduled run; Android may defer background work to save battery.

## Behavior and limits

- WorkManager periodic work has a 15-minute minimum interval and is deferrable; Android battery policies may delay it. It is not a minute-by-minute alarm.
- A first online launch is needed to populate the app's offline JSON cache.
- The web interface is bundled in the APK at build time. Later website UI changes require a new APK build; the data remains live.
- Charts or map tiles that rely on third-party CDN/network resources may be incomplete offline. Core pages and cached weather JSON remain available.
- Rain alert thresholds are centralized in `WeatherData.java`: observed 1-hour precipitation ≥0.5 mm, or forecast 6-hour precipitation ≥1.0 mm in the next six hours. Separate six-hour cooldowns suppress repeated notifications.
- Alerts are delivered only after Android notification permission is granted and the **Yağış uyarıları** notification channel remains enabled in Android settings.

## Safety of the existing weather service

All work is isolated on the `android-capacitor` branch. The production website, GFS workflows, station workflows and Pages deployment on `main` are not changed by this branch.