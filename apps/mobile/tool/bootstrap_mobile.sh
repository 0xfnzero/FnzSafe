#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v flutter >/dev/null 2>&1; then
  echo "flutter is required. Install Flutter SDK first." >&2
  exit 1
fi

flutter create --platforms=ios,android --org dev.fnzero.safe .
flutter pub get

if [[ -f ios/Podfile ]]; then
  if grep -q "^# platform :ios" ios/Podfile; then
    perl -0pi -e "s/# platform :ios, '[^']+'/platform :ios, '15.0'/" ios/Podfile
  elif grep -q "^platform :ios" ios/Podfile; then
    perl -0pi -e "s/platform :ios, '[^']+'/platform :ios, '15.0'/" ios/Podfile
  else
    printf "platform :ios, '15.0'\n%s" "$(cat ios/Podfile)" > ios/Podfile
  fi
fi

if [[ -f ios/Runner/Info.plist ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName FnzSafe" ios/Runner/Info.plist 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string FnzSafe" ios/Runner/Info.plist
  /usr/libexec/PlistBuddy -c "Add :NSCameraUsageDescription string Scan wallet addresses and dApp URLs." ios/Runner/Info.plist 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Set :NSCameraUsageDescription Scan wallet addresses and dApp URLs." ios/Runner/Info.plist
  /usr/libexec/PlistBuddy -c "Add :NSFaceIDUsageDescription string Confirm wallet unlock and signing actions." ios/Runner/Info.plist 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Set :NSFaceIDUsageDescription Confirm wallet unlock and signing actions." ios/Runner/Info.plist
fi

android_gradle=""
if [[ -f android/app/build.gradle ]]; then
  android_gradle="android/app/build.gradle"
elif [[ -f android/app/build.gradle.kts ]]; then
  android_gradle="android/app/build.gradle.kts"
fi

if [[ -n "$android_gradle" ]]; then
  perl -0pi -e "s/minSdk(?:Version)?\\s*[= ]\\s*flutter\\.minSdkVersion/minSdk = 26/g; s/minSdk(?:Version)?\\s+[0-9]+/minSdkVersion 26/g; s/applicationId\\s*=\\s*\"[^\"]+\"/applicationId = \"dev.fnzero.safe\"/g; s/applicationId\\s+\"[^\"]+\"/applicationId \"dev.fnzero.safe\"/g" "$android_gradle"
fi

if [[ -f android/app/src/main/AndroidManifest.xml ]]; then
  manifest="android/app/src/main/AndroidManifest.xml"
  grep -q "android.permission.INTERNET" "$manifest" \
    || perl -0pi -e "s|<manifest([^>]*)>|<manifest\$1>\n    <uses-permission android:name=\"android.permission.INTERNET\" />|" "$manifest"
  grep -q "android.permission.CAMERA" "$manifest" \
    || perl -0pi -e "s|<manifest([^>]*)>|<manifest\$1>\n    <uses-permission android:name=\"android.permission.CAMERA\" />|" "$manifest"
  grep -q "android.permission.USE_BIOMETRIC" "$manifest" \
    || perl -0pi -e "s|<manifest([^>]*)>|<manifest\$1>\n    <uses-permission android:name=\"android.permission.USE_BIOMETRIC\" />|" "$manifest"
  perl -0pi -e "s/android:label=\"[^\"]+\"/android:label=\"FnzSafe\"/" "$manifest"
fi

echo "Mobile Flutter shell is ready."
