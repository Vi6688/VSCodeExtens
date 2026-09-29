# Change Log

## [0.1.0]

- Redesigned sidebar with sections, icons, values, tooltips, toolbar buttons and a status bar item.
- Selections persist to workspace settings.
- Builds are parallel (`jobs`) and only re-configure when needed.
- Actions run as VS Code tasks: single shared panel, Problems panel integration, running state, Stop.
- Transfer rewritten around `scripts/transfer.sh`: port/number/alias/user@host targets, parallel uploads,
  sshpass support with the password kept in SecretStorage, Build/Transfer/Install for InstallerPackage targets.

## [0.0.1]

- Initial release
