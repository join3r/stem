#!/usr/bin/env bash
# Archive the iOS app and upload it to TestFlight.
#
# Needs an App Store Connect API key (App Store Connect → Users and Access →
# Integrations → App Store Connect API → Team Keys, role "App Manager"):
#   ASC_KEY_ID      the key id (e.g. 2X9R4HXF34)
#   ASC_ISSUER_ID   the issuer id shown above the key list
#   ASC_KEY_PATH    path to the downloaded AuthKey_<keyid>.p8
#
# The App Store Connect app record for sk.awantech.stem must exist before the
# first upload (created once, by hand, at appstoreconnect.apple.com).
# manageAppVersionAndBuildNumber in export-options.plist lets Xcode bump the
# build number past what TestFlight already has, so re-runs just work.
set -euo pipefail

: "${ASC_KEY_ID:?set ASC_KEY_ID to the App Store Connect API key id}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID to the App Store Connect issuer id}"
: "${ASC_KEY_PATH:?set ASC_KEY_PATH to the AuthKey .p8 file}"

cd "$(dirname "$0")/.."
KEY_PATH="$(cd "$(dirname "$ASC_KEY_PATH")" && pwd)/$(basename "$ASC_KEY_PATH")"
ARCHIVE="ios/build/Stem.xcarchive"

AUTH=(-allowProvisioningUpdates
      -authenticationKeyPath "$KEY_PATH"
      -authenticationKeyID "$ASC_KEY_ID"
      -authenticationKeyIssuerID "$ASC_ISSUER_ID")

xcodebuild archive \
  -workspace ios/Stem.xcworkspace \
  -scheme Stem \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  "${AUTH[@]}"

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist scripts/export-options.plist \
  -exportPath ios/build/export \
  "${AUTH[@]}"

echo "Uploaded. Watch processing at https://appstoreconnect.apple.com → Stem → TestFlight."
