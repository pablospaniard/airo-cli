# Security

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability involving credentials, authentication, encryption, sync authorization, or sensitive user data.

Report security issues privately through GitHub's **Security advisories** page for this repository:

<https://github.com/pablospaniard/airo-cli/security/advisories/new>

Include the affected version, operating system, reproduction steps, impact, and any suggested mitigation. Please avoid including real credentials, private source code, or user data.

## Supported versions

Security fixes are provided for the latest stable release. Users should upgrade to the newest published `airo-ai-router` version before reporting an issue that may already be fixed.

## Security boundaries

- AIRO executes separately installed provider CLIs with the permissions selected by the user.
- Core routing and learning are local; optional network features require separate configuration or consent.
- Provider credentials and API keys are not synchronized by AIRO.
- Encrypted sync protects record contents from the service operator, but traffic metadata and account/device identity remain visible.
- A compromised local machine, provider CLI, shell environment, or extension host can access data available to that process.

See [Privacy](PRIVACY.md), [Jev and AIRO](docs/jev-and-airo.md), and the [sync Worker documentation](sync-worker/README.md) for the detailed data boundaries.
