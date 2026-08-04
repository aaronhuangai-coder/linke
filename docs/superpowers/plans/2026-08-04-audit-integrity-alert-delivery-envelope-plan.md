# Audit integrity alert delivery envelope plan

1. Add behavior-specific tests for exact validation, frozen envelope/request shape, stable idempotency, fixed failure mapping, and zero I/O/network wiring; run the focused RED.
2. Add the minimal pure delivery-envelope module and make the focused tests GREEN.
3. Update Gold/README honesty contracts without changing the 6/3/0/9 score.
4. Run focused, related, and full regression suites plus diff checks.
5. Require GLM adversarial review, Qwen statistics, and Kimi closure before exact-scope commit/push.
