# BooruFlow contributor instructions

Read [the documentation index](docs/README.md) and [architecture](docs/en/development/architecture.md) before changing the application. Use [CONTEXT.md](CONTEXT.md) for domain terms.

- Before changing an interface, configuration or data structure, read [contracts](docs/en/development/contracts.md). Keep machine definitions in `schema/` and shared configuration in `config/`; callers read the same source.
- Before changing database or media behavior, read [data transfer](docs/en/user/data-transfer.md) and [update and recovery](docs/en/user/update-recovery.md). Follow the migration change rules in [contracts](docs/en/development/contracts.md).
- Before changing a page, read [interface rules](docs/en/development/interface-guidelines.md). Preserve the existing request, focus, keyboard, loading and error behavior.
- Before running checks, read [testing](docs/en/development/testing.md). Use isolated temporary databases, fixed local fixtures and mock model services. Cover normal, error and boundary branches for new behavior.
- Before submitting changes, read [PR guidelines](docs/en/community/pull-requests.md). Report the changed behavior and actual verification results, and update corresponding documentation in all four languages.
- Keep deployment data, credentials, screenshots of personal data and local development records in the relevant local environment. Use public sample data for documentation screenshots.

Documentation reviews must use an independent reader. Supply only the draft and these writing criteria: complete sentences with an explicit subject, action, object and condition; familiar terminology; clear file and data ownership; one definition per requirement with references elsewhere; sections serving their stated purpose; error messages describing the situation and the next user action. The reader returns a pass or a specific correction for each criterion; the author resolves corrections before delivery.
