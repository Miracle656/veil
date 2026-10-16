#!/usr/bin/env bash
set -eo pipefail

# Release APK: the JS bundle is inside the app. The debug APK is an Expo
# dev client and stops on the launcher until a packager is attached.
adb install -r android/app/build/outputs/apk/release/app-release.apk

# The app pushes /offline whenever NetInfo reports no usable
# connection, and a freshly booted emulator often has not finished
# bringing its network up. Without this wait every flow fails on the
# cold-start assertion before it reaches anything it meant to test.
# The flows also dismiss the offline screen defensively, so a failure
# to validate here degrades rather than blocks.
for i in $(seq 1 30); do
  if adb shell dumpsys connectivity 2>/dev/null | grep -q "VALIDATED"; then
    echo "Emulator network validated"
    break
  fi
  echo "Waiting for emulator network ($i/30)"
  sleep 5
done

# The Pixel launcher ANRs under the release build and leaves a system dialog
# over the app. Hide those dialogs, and stop the launcher so it is not already
# wedged when the first flow starts. launch-fresh also taps "Close app".
adb shell settings put global hide_error_dialogs 1 || true
adb shell am force-stop com.google.android.apps.nexuslauncher || true

maestro test .maestro --format junit --output maestro-report.xml
