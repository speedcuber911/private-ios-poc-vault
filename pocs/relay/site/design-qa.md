# Design QA

- Reference: Homebrew install-command treatment supplied by the user.
- Implementation: Relay hero install strip at `http://127.0.0.1:4173/`.
- Desktop check: 1308 x 768 Chrome content viewport.
- Mobile check: responsive 400 x 540 viewport.
- Interaction check: copy control changes to `Copied` after writing the command.
- Comparison: `/tmp/relay-design-qa/comparison.png` combines the reference and implementation.
- Review: dark command surface, monospaced command, shell prompt, separated copy control, Relay typography/colors, responsive truncation, and hero spacing all match the intended provider pattern without copying Homebrew branding.
- Console: application code produced no errors; local preview requested a missing favicon only.

final result: passed
