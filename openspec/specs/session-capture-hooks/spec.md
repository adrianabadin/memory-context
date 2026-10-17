# Session Capture Hooks Spec

## Purpose

Capture session prompts and tool calls with zero agent tokens.

## Requirements

### Requirement: R1 MUST register capture hooks and append synchronously
The plugin MUST register `chat.message` and `tool.execute.after` at plugin load and MUST only append queue records synchronously to `.opencode/pmc-capture-queue.jsonl`.

#### Scenario: Plugin loads
- GIVEN the PMC plugin is loaded
- WHEN hooks are exported
- THEN both capture hooks are registered before session activity

#### Scenario: User message captured
- GIVEN a `chat.message` event for a user role
- WHEN content arrives
- THEN one queue line is appended with `type`, `ts`, `sessionId`, `projectId`, and payload

#### Scenario: Tool call captured
- GIVEN a `tool.execute.after` event
- WHEN the tool completes
- THEN one queue line is appended with `tool_name`, `args_safe`, `result_summary`, and `duration_ms`

### Requirement: R2 MUST redact secrets before append
The plugin MUST remove `<private>...</private>` content before append and MUST sanitize `args_safe` for token, API-key, and secret-like patterns at append time, not in the drainer.

#### Scenario: Private tags in chat content
- GIVEN message content contains `<private>secret</private>`
- WHEN the hook appends the event
- THEN the stored content excludes the private segment

#### Scenario: Secret-like tool args
- GIVEN tool arguments contain a bearer token or API key pattern
- WHEN the hook builds `args_safe`
- THEN the sensitive value is redacted before the line is written

#### Scenario: Mixed safe and unsafe args
- GIVEN arguments include public fields and secret fields
- WHEN sanitization runs
- THEN public fields remain and secret fields are redacted

### Requirement: R3 SHOULD capture assistant messages when supported
The plugin SHOULD detect whether `chat.message` fires for assistant role messages and SHOULD capture them with the same session envelope when available; otherwise it SHALL continue prompt and tool capture without blocking.

#### Scenario: Assistant role is emitted
- GIVEN `chat.message` fires for assistant role content
- WHEN the hook receives the event
- THEN the assistant message is appended

#### Scenario: Assistant role is not emitted
- GIVEN no assistant event is exposed by OpenCode
- WHEN prompts and tools are captured
- THEN capture continues and the limitation is documented as best-effort

#### Scenario: Hook error while checking role
- GIVEN role detection fails for one message
- WHEN the hook handles the event
- THEN the failure does not block later appends

## Out of Scope
- Backfilling historical sessions
- Network or async work inside hooks
- Guaranteeing assistant capture when OpenCode exposes no event
