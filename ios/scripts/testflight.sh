#!/usr/bin/env bash
# Archive the iOS app and upload it to TestFlight.
#
# Uses the signed-in Xcode account, or an App Store Connect API key
# (App Store Connect → Users and Access → Integrations → App Store Connect API
# → Team Keys, role "App Manager"):
#   ASC_KEY_ID      the key id (e.g. 2X9R4HXF34)
#   ASC_ISSUER_ID   the issuer id shown above the key list
#   ASC_KEY_PATH    path to the downloaded AuthKey_<keyid>.p8
#
# manageAppVersionAndBuildNumber in export-options.plist lets Xcode bump the
# build number past what TestFlight already has, so re-runs just work.
set -euo pipefail

cd "$(dirname "$0")/.."
ARCHIVE="build/Stem.xcarchive"

AUTH=(-allowProvisioningUpdates)
if [[ -n "${ASC_KEY_ID:-}${ASC_ISSUER_ID:-}${ASC_KEY_PATH:-}" ]]; then
  : "${ASC_KEY_ID:?set all three ASC variables, or unset them to use the Xcode account}"
  : "${ASC_ISSUER_ID:?set all three ASC variables, or unset them to use the Xcode account}"
  : "${ASC_KEY_PATH:?set all three ASC variables, or unset them to use the Xcode account}"
  KEY_PATH="$(cd "$(dirname "$ASC_KEY_PATH")" && pwd)/$(basename "$ASC_KEY_PATH")"
  AUTH+=(-authenticationKeyPath "$KEY_PATH"
         -authenticationKeyID "$ASC_KEY_ID"
         -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi

xcodegen generate

xcodebuild archive \
  -project Stem.xcodeproj \
  -scheme Stem \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  "${AUTH[@]}"

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist scripts/export-options.plist \
  -exportPath build/export \
  "${AUTH[@]}"

echo "Uploaded. Watch processing at https://appstoreconnect.apple.com → Stem → TestFlight."
