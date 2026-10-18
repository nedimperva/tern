#!/usr/bin/env bash
# Points tern-bin at a published GitHub release and rewrites its checksums and .SRCINFO:
#   packaging/aur/bump.sh 0.4.0
# The release must be published (not a draft), or its .deb can't be downloaded.
set -euo pipefail
version=${1:?usage: packaging/aur/bump.sh VERSION}
cd "$(dirname "$0")/tern-bin"
sed -i -e "s/^pkgver=.*/pkgver=$version/" -e "s/^pkgrel=.*/pkgrel=1/" PKGBUILD
sums=$(makepkg --geninteg 2>/dev/null)
awk -v sums="$sums" '/^sha256sums=\(/ { skip = 1; print sums } skip { if (/\)$/) skip = 0; next } { print }' \
  PKGBUILD > PKGBUILD.new
mv PKGBUILD.new PKGBUILD
makepkg --printsrcinfo > .SRCINFO
rm -rf ./*.deb LICENSE-* src
echo "tern-bin $version: try it with 'cd packaging/aur/tern-bin && makepkg -si', then publish (packaging/aur/README.md)."
