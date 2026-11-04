# Security

## Reporting a problem

If you find a security problem, such as a key or token being printed, logged or sent somewhere it should not be, please open a private security advisory on GitHub (Security tab, "Report a vulnerability") instead of a public issue.

## What clispare is built to protect

- API keys are stored in `~/.clispare` with mode `0600`, and are never printed, logged, or written to `accounts.json` or `state.json`.
- Stray credential environment variables are removed before a real CLI is started.
- There is no telemetry. The only network call is the one request you ask for.

## Your responsibility

Optional account rotation (`--rotate-accounts`) can break a provider's terms of service. See the README before turning it on.
