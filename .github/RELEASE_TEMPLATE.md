# Veesker Community Edition — v{{VERSION}}

> **Download:** see the Assets section below.
> Windows: `Veesker_{{VERSION}}_x64-setup.exe` · macOS: `Veesker_{{VERSION}}_aarch64.dmg` / `Veesker_{{VERSION}}_x64.dmg`

---

## What's new

<!-- Paste the relevant section from CHANGELOG.md here -->

---

## Installation

### Windows
Run `Veesker_{{VERSION}}_x64-setup.exe`. Windows SmartScreen may warn "Windows protected your PC" — click **More info → Run anyway**. Code signing via Azure Trusted Signing is in progress.

### macOS
Open `Veesker_{{VERSION}}_aarch64.dmg` (Apple Silicon) or `Veesker_{{VERSION}}_x64.dmg` (Intel) and drag Veesker to Applications. On first launch you may need to **Right-click → Open** to bypass Gatekeeper.

### Linux
Build from source — see [CLAUDE.md](https://github.com/veesker-cloud/veesker-community-edition/blob/main/CLAUDE.md). Packaged Linux releases are not yet available.

---

## Sidecar binary note

This release ships a **pre-compiled sidecar binary** for the host platform. If you see `-32601 Method not found` errors in the schema browser, the embedded binary may be stale. Rebuild it locally:

```bash
cd sidecar
bun run build:win-x64   # Windows
# or
bun run build:mac-arm64 # Apple Silicon
# or
bun run build:mac-x64   # Intel Mac
```

---

## Known issues in this release

<!-- List any known issues that were not fixed before tagging, e.g. from CHANGELOG.md [Unreleased] ### Known Issues -->

---

## Checksums

<!-- SHA-256 checksums for all release assets, generated at release time -->

```
SHA-256 checksums:
<paste output of sha256sum / CertUtil -hashfile here>
```

---

## Full changelog

[CHANGELOG.md](https://github.com/veesker-cloud/veesker-community-edition/blob/main/CHANGELOG.md)

---

Veesker Community Edition is free forever under [Apache 2.0](https://github.com/veesker-cloud/veesker-community-edition/blob/main/LICENSE). No telemetry. No license server. No kill-switch.
