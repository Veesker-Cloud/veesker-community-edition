# Security Policy

## Reporting Vulnerabilities

If you discover a security issue, **do not open a public issue**.

Email: **geraldovianajr@veesker.cloud**

Include:
- Description of the issue
- Steps to reproduce
- Affected version (visible in the app menu Veesker → About, or in `package.json`)
- Your contact for follow-up

We aim to respond within 7 days. After confirmation, we will coordinate a fix and disclosure timeline with you.

## Supported Versions

Only the latest published release receives security updates. Older versions are not patched. Update via the in-app updater or by downloading the latest installer.

## Scope

Veesker is a desktop client. The threat model focuses on:
- Local credential storage (OS keychain via the `keyring` crate)
- Sidecar process isolation (Bun runs as a child process via stdin/stdout)
- HTTP requests made by the app (Anthropic API, ORDS endpoints — allowlisted)
- Update integrity (Ed25519 signature verification)

Out of scope:
- Vulnerabilities in Oracle Database itself
- Vulnerabilities in third-party libraries (report upstream)
- Misconfiguration by the user (e.g., shared credentials, weak passwords)
- Issues caused by running modified or unofficial builds

## No Warranty

This software is provided "AS IS" under the Apache License 2.0. There is **no warranty** of any kind. See [LICENSE](LICENSE) sections 7 and 8 for the full disclaimer.

## Coordinated Disclosure

We follow responsible disclosure: please give us a reasonable window to fix the issue before publishing details. We will credit reporters in release notes (unless you prefer to remain anonymous).
