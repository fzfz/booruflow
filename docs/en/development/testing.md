# Testing

Run `npm ci` and use separate ports, temporary databases, and fixed fixtures. Automated tests must not contact production databases, real credentials, live source sites, or real model services.

Main commands are `npm run test:unit`, `npm run test:contract`, `npm run test:integration`, `npm run test:migration`, `npm run test:native`, `npm run test:e2e:files`, and `npm test`. `npm run check:test-boundaries` checks static boundaries; `npm run check:test-markdown` confirms tests do not use Markdown as structured data. Run the affected layer first and the full suite after the change stabilizes.

Contract tests cover Schema, OpenAPI, errors, migrations, and routes; unit tests cover business branches; integration tests cover module combinations and transactions; e2e checks rendered behavior. Test platform scripts on their Windows x64 and macOS arm64/x64 targets, including installation, lifecycle, update, restore, and data interchange. Cover normal, error, and boundary branches.

Development acceptance requires at least 85% line and 80% branch coverage, with 100% for critical transaction, media recovery, and query-client branches. On failure save the command, exit code, first relevant error, layer, and artifact path. Fix the identified cause and rerun affected checks. CI retains run results.

The coverage percentages above are development acceptance requirements. Current CI gates use the exit results of the workflow test jobs and do not automatically calculate those percentages; maintainers provide coverage evidence in the PR. See [CI/CD gates](ci-cd.md) for merge and release enforcement.
