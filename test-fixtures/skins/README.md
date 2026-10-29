# Replay Lab skin test fixtures

Place one or more real `.osk` osu! skin archives in this directory so the automated Replay Lab tests can exercise the actual skin files.

- Keep the original `.osk` archive intact; do not extract it.
- Use a short descriptive filename, for example `mania-skin-example.osk`.
- Only add skins you are allowed to redistribute. If a skin cannot be committed publicly, use a small synthetic test fixture instead or provide a link to a permitted download.

The current test suite does not yet automatically load these archives; this directory reserves a stable location for the upcoming archive-level integration test.