# Audit Integrity Alert Capture CLI Implementation Plan

1. Add real subprocess tests for strict argv, cold alert capture, repeated occurrences, healthy no-outbox behavior, refusal sanitization, help honesty, and source isolation. Run them before implementation and retain the behavioral RED.
2. Import only `enqueueAuditIntegrityAlertOutbox` into `src/agent.js`; add a dedicated command constant, exact raw+parsed argv validator, fixed public messages, and the new command to the local strict-command set.
3. Add one switch case that awaits monitor first, then enqueue, prints the compact receipt, and derives exit 0/2 from the issued report. Map known audit-integrity refusal to fixed exit 2 and all other post-validation failures to fixed exit 1.
4. Update README and Gold production-hardening evidence without changing the 6/3/0/9 score or claiming delivery/scheduling/Gold.
5. Run focused, monitor/outbox/Agent-related, and full suites plus diff checks; obtain GLM adversarial review, Qwen evidence statistics, and Kimi closure review before the scoped commit and push.
