# Custom CMake

A sidebar for configuring, building and deploying a CMake project to remote targets over scp/ssh.

## Sidebar

**Build**: architecture, build type, target, threads (parallel jobs).
**Transfer**: username, hostname, targets, password.
**Actions**: Configure, Build, Transfer, Build and Transfer, Transfer and Install and
Build, Transfer and Install (both only for targets whose name contains `InstallerPackage`), Clean, and Stop while something is running.

Selections are saved to your workspace settings. Everything runs as a VS Code task in one shared
panel: compiler errors show up in the Problems panel, a spinner shows the running action, and the
status bar item (or the Stop button) cancels it. Modified files are saved before building.

Build re-configures automatically when the build type, configure command, architecture or build
directory changed, or when `CMakeCache.txt` is missing.

## Transfer targets

Each entry in `CustomCMake.transfer` is one target; all are uploaded to in parallel to the home directory.

| Entry | Resolves to |
|---|---|
| `15206` (5 digits) | `<user>@<hostname>[.<hostDomain>]` on ssh port 15206 |
| `154` (digits) | `<user>@<hostPrefix>154` |
| `bsnl154` | `<user>@bsnl154` |
| `user@host` | used as written |

Package targets (`*InstallerPackage`) upload the newest `packagePattern` file (default `*.ipk`).
Other targets upload the newest executable with the target's name. **Transfer and Install** (no build) and **Build, Transfer and Install**
also run `opkg install --force-reinstall` on each target and removes the file after a successful install.

## Password

Transfers use `sshpass` (`sudo apt install sshpass`) for scp, ssh and remote sudo. The password is a
built-in default unless you run `Custom CMake: Set Remote Password`, which stores your own in VS Code's
SecretStorage (click the Password row again to reset to the default). If `sshpass` is missing, the
transfer falls back to normal ssh authentication.

**Custom password lost after reload (Linux):** VS Code picks its keyring from the desktop environment. On KDE
with only `gnome-keyring` running it can't reach a keyring and the password is not persisted. Add
`"password-store": "gnome-libsecret"` to `~/.vscode/argv.json`, fully restart VS Code, and set the password again.

## Settings

`buildDirectory`, `configureCommand`, `jobs` (0 = one per CPU core), `saveBeforeBuild`,
`systems`, `hostnames`, `hostDomain`, `hostPrefix`, `transferOptions`, `packagePattern`
(plus the selections above). See the Settings UI under "Custom CMake".
