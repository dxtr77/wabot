# WABot AI Handoff

## Objective
Finish the WABot refactor safely in /home/hasko/wabot/wabot.
Preserve current behavior, production data, and WhatsApp authentication.

## Safety rules
- Do not restart or reload systemd service `bot` without explicit approval.
- Never print, request, or include secrets from .env files.
- Preserve data/auth, databases, persistent state, and production configuration.
- Do not delete timestamped backups.
- Inspect changes and test before moving more modules.

## Last reported verification
- Test command:
  node --experimental-test-module-mocks --test tests/*.test.js
- Last result: 53 passed, 0 failed.
- `systemctl is-active bot` last returned `active`.
- Re-run checks because these results may not cover every production import path.

## Work reported completed
- Owner authorization and quoted bot identity checks hardened.
- WhatsApp reconnect controller and startup cleanup improved.
- Message handler, parsing, quoted context, and message actions reorganized.
- Command parsing moved under commands/.
- LLM moved to ai/; persistent AI key-state path adjusted.
- Agent tools moved to ai/tools/.
- Tool loop and AI provider moved under ai/.

## Next steps
1. Audit relative imports in src/ai/ai-provider.js and other moved modules.
2. Check actual module loading, not just mocked tests.
3. Run the full test suite and report failures.
4. Review remaining modules and architecture before further moves.
5. Review command authorization and feature parity.
6. Report progress, risks, and test results after each phase.
7. Do not restart the production service without approval.
