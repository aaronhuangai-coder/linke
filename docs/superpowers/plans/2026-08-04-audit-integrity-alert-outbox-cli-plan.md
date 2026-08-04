# Audit Integrity Alert Outbox CLI Implementation Plan

1. Add real Agent subprocess tests for absent read, populated read, exact-head ack, empty ack, wrong-head no-rewrite, corrupt refusal, strict argv, help honesty, and no server wiring. Preserve the pre-implementation behavioral RED.
2. Add command-specific constants and strict raw argv parsers in `src/agent.js`; add both commands to the local strict-command set.
3. Wire only the existing public read and acknowledgement APIs, emit compact closed JSON, and map refusal/unexpected errors to fixed path-free messages and 2/1 exits.
4. Update README and production-hardening evidence while retaining the Gold 6/3/0/9 and non-delivery/non-scheduler ceilings.
5. Run focused, related, and full suites plus diff checks; obtain GLM adversarial, Qwen statistical, and Kimi closure PASS before a scoped commit and push.
