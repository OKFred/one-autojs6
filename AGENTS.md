# Repository Guidance

Read and follow `.agents/AGENTS.md` for the project-specific task, JSDoc, Swagger and response-envelope rules.

## Text and line endings

- All repository text files must be UTF-8 without BOM and use LF line endings.
- Never introduce CRLF-only diffs. Respect the root `.editorconfig` and `.gitattributes`.
- Do not normalize or rewrite vendored code or nested repositories such as `pc/ws-scrcpy` only for line-ending changes.
- Before handoff, run `git diff --check` and inspect line-ending-only changes with `git diff --ignore-space-at-eol`.
- Do not change global Git settings as part of repository work.
