---
'@truefoundry/trueforge-core': minor
---

A tool response that continues the session tip (`previous_turn_id` omitted or `'auto'`) now commits only while that tip is still the finished turn waiting on the call; otherwise `createTurn` rejects with the new `SessionTipMovedError`, or the new `SessionTipRunningError` while that tip is still running (both `SessionStoreConflictError`s), and writes nothing. Such a resume no longer freezes a running tip. Explicit `previous_turn_id` forks are unchanged.

Store implementations: `CreateTurnInput` gains the required `require_tip: boolean`; when true, the turn is written only if `session.last_turn_id` equals `turn.previous_turn_id`, checked in the same atomic unit that advances the tip.

Sandbox providers: `SandboxProviderTools` gains the required `rootCapability` (an `AgentCapability`, or `undefined` for none), given to the root thread only: client-side tools such as a takeover request and the instructions naming them. `tools` and `instructions` reach every thread.
