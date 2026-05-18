# Project Backlog

## Open Work

- [ ] Adapt `pi-xai-voice` to the finalized voice-provider contract.
  - Priority: High after `0.11.0` lands.
  - Idea: Update provider imports to `@llblab/pi-telegram/lib/voice.ts`, persist `voice.replyMode` to the same `telegram.json` location pi-telegram reads, return `transcriptText` only when the provider's transcript toggle is enabled, and rely on provider-owned OGG/Opus conversion.
  - Exit: `pi-xai-voice` works against `pi-telegram@0.11.x` without direct `globalThis` access or fork-local import resolution.

- [ ] Explore always-available outbound Telegram tools for queued artifacts and controls.
  - Priority: Low.
  - Idea: Provide tools such as `telegram_attach_file` and `telegram_attach_button` that can be called outside an active Telegram turn, using the paired chat/session as the delivery target when safe.
  - Exit: Design note defines active-turn versus ambient delivery semantics, safety constraints, failure modes, and whether the current `telegram_attach` contract should stay turn-scoped or gain an ambient companion.
