# Changelog

## 1.0.4 - 2026-10-06

- Improve automatic sidebar scrolling while streamed output and attachment previews change the layout.
- Pause scrolling when the user scrolls up and resume it when the chat reaches the bottom.
- Document the release package name and the post-install verification steps.

## 1.0.3 - 2026-10-06

- Add inline previews in the attachment composer instead of showing only file names.
- Pause automatic scrolling when the user scrolls up and resume it at the bottom.

## 1.0.2 - 2026-09-30

- Update the extension release for compatibility with AIRO CLI 1.0.3.

## 1.0.1 - 2026-09-30

- Fall back to the `airo` executable when the command setting is empty or whitespace.

## 1.0.0 - 2026-09-30

- Add a stateful AIRO chat in the VS Code secondary sidebar.
- Support parallel chats, saved sessions, attachments, pasted images, and inline artifact previews.
- Stream provider and phase progress with routing, model, and output controls.
- Add commands for models, accounts, usage, logs, diagnostics, feedback, learning, and repository identity.
- Add guarded Jev consent and per-run opt-out controls.
- Add end-to-end encrypted sync login, status, device, export, logout, and deletion controls.
- Use the local AIRO CLI and its existing provider accounts without storing provider credentials in the extension.
