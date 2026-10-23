# Provenance and contribution boundary

MCP Preview Contract was prepared on 23 October 2026 as an AI-assisted original software contribution for Jordan Skinner. It generalizes lessons from developing and reviewing Household Brain's preview-bound writes: compare actual backing state, reject stale confirmations, require a fresh explicit confirmation, and keep uncertain outcomes separate from safe rejection.

The contribution is a separate developer tool, rather than a clone of the primary Household Brain application. Its reusable runner maps application-specific arguments and results through an adapter, compares independent state and mutation-journal evidence, and emits machine-readable receipts. Its examples reserve synthetic assembly parts and complete synthetic tasks. The primary app's UI, pantry, household members, meal fixtures and household server are not copied into this project.

The contract profile and implementation use AI assistance. This document does not assert sole manual authorship, third-party adoption or independent production validation. Original design and implementation work, test runs, review findings and archive hashes should be evaluated from their actual source history and retained receipts, rather than inferred from this statement.

## Third-party components

The examples use the Model Context Protocol TypeScript SDK and Zod, pinned in package-lock.json. The SDK supplies real `Client`, `McpServer` and paired in-memory transport behavior. These dependencies are imported, not represented as original project code. Their own licenses and notices remain applicable; the project's MIT license does not replace them. No dependency-license inventory count is asserted here.

The protocol reference is the [official MCP tools specification for 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). The project's `preview-confirm-v1` profile is an optional application convention, not an amendment to that specification, a certification, authentication or proof of human review. The examples' independent observers and fixture oracles are trusted test code, not an externally audited security boundary.

## Hackathon contribution record

The [Amazon Build, Ship, Shape rules](https://amazonappdev2026.devpost.com/rules) describe an Open Source mini-challenge contribution alongside a primary-track project, created or contributed during the hackathon window. They require contribution and project repository URLs, a GitHub username, and an explanation of what was done, how it works and why it matters.

This local project was prepared during the 31 August to 23 October 2026 submission window. Local preparation alone is not a published contribution or a submitted entry. Exact public publication approval remains pending. The actual authorized repository/contribution URLs, GitHub username, publication timestamp, final tests, license review and submission receipt must be recorded before claiming completion. Organizer eligibility and judging decisions are not established by file timestamps or this document.

The intended contribution is the reusable runner, explicit adapter API, independent state and journal assertions, two distinct real-SDK examples, fault-sensitivity tests and standalone instructions. Its usefulness is that another developer can apply the same checks to a different preview-bound write tool without importing the primary household application. This is a description of the supplied interface and intended use, not a claim of outside adoption or an assurance of competitive results.

## License and current release scope

The source is provided under the [MIT license](LICENSE), copyright 2026 Jordan Skinner. Preserve that license and applicable third-party notices when distributing the source.

Current scope is local preparation and review only. No public repository creation, public push, merge, npm publication or final hackathon submission is authorized by these documents. The package's `private` flag blocks npm registry publication while preserving the option of a separately approved public MIT-licensed source repository.
