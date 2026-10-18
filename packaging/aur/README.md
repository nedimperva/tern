# AUR packages

`tern-bin` repackages the release's `.deb` for Arch (and Omarchy): `yay -S tern-bin`. It updates through the
AUR helper; Tern itself never self-updates outside the AppImage and Windows builds. A `tern` package that builds
from source is not written yet.

## Publishing (maintainer)

Once: create an account on [aur.archlinux.org](https://aur.archlinux.org), add an SSH key to it, and clone the
package's AUR repository next to this one:

```
git clone ssh://aur@aur.archlinux.org/tern-bin.git ../tern-bin-aur
```

Each release, after the GitHub release is published (a draft's files can't be downloaded):

1. `packaging/aur/bump.sh 0.4.0` sets the version and checksums and writes `.SRCINFO`.
2. `cd packaging/aur/tern-bin && makepkg -si` builds and installs it; start Tern and check it opens.
3. Commit `PKGBUILD` and `.SRCINFO` here.
4. Copy both into `../tern-bin-aur`, then `git commit -m "Update to 0.4.0" && git push` there.

Changing only the PKGBUILD (a dependency, say) keeps `pkgver` and raises `pkgrel` by one instead.
