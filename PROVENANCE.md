# Provenance and contribution boundary

MCP Preview Contract was prepared on 23 October 2026 as an AI-assisted original software contribution for Jordan Skinner. It generalizes lessons from developing and reviewing Household Brain's preview-bound writes: compare actual backing state, reject stale confirmations, require a fresh explicit confirmation, and keep uncertain outcomes separate from safe rejection.

The contribution is a separate developer tool, rather than a clone of the primary Household Brain application. Its reusable runner maps application-specific arguments and results through an adapter, compares independent state and mutation-journal evidence, and emits machine-readable receipts. Its examples reserve synthetic assembly parts and complete synthetic tasks. The primary app's UI, pantry, household members, meal fixtures and household server are not copied into this project.

The contract profile and implementation use AI assistance. This document does not assert sole manual authorship, third-party adoption or independent production validation. Original design and implementation work, test runs, review findings and archive hashes should be evaluated from their actual source history and retained receipts, rather than inferred from this statement.

## Kiro Crew development record

On 23 October 2026, Kiro Crew 0.9.0, using its bundled Kiro CLI 2.31.1 and the selected Claude Sonnet 4.5 model, performed one development task with a review continuation on an isolated copy of source commit `c89abf0e9210f42912eed6a59108210e87dc208a`. The task began at 12:49:36 UTC and its correction finished at 13:14:39 UTC. Kiro added the observation-window option, delayed handler write/rollback/rejection faults in both real-SDK examples, regression tests, types and documentation. This was actual local development with file reads, edits and test commands, not installation alone or a runtime AWS integration.

Independent Codex review found remaining timing defects and a syntax error in Kiro's last test edit despite its claimed passing results. Codex preserved both Kiro iterations, repaired full-window and zero-window sampling, strengthened timing and observer tests, and separately verified the final candidate. Attribute the reviewed result to Kiro-assisted development plus Codex review and repairs; Kiro's test assertions alone are not validation evidence. The accompanying integration receipts distinguish the original Kiro patches from the final candidate.

Supporting task and verification receipts are retained separately from public source. No Bedrock runtime success or AWS Builder mini-challenge acceptance is claimed by this development record.

## Third-party components

The examples use the Model Context Protocol TypeScript SDK and Zod, pinned in package-lock.json. The SDK supplies real `Client`, `McpServer` and paired in-memory transport behavior. These dependencies are imported, not represented as original project code. Their own licenses and notices remain applicable; the project's MIT license does not replace them. No dependency-license inventory count is asserted here.

The protocol reference is the [official MCP tools specification for 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). The project's `preview-confirm-v1` profile is an optional application convention, not an amendment to that specification, a certification, authentication or proof of human review. The examples' independent observers and fixture oracles are trusted test code, not an externally audited security boundary.

## Hackathon contribution record

The [Amazon Build, Ship, Shape rules](https://amazonappdev2026.devpost.com/rules) describe an Open Source mini-challenge contribution alongside a primary-track project, created or contributed during the hackathon window. They require contribution and project repository URLs, a GitHub username, and an explanation of what was done, how it works and why it matters.

The [baseline source at c89abf0](https://github.com/jskinner-bizai/mcp-preview-contract/commit/c89abf0e9210f42912eed6a59108210e87dc208a) is public in the [project repository](https://github.com/jskinner-bizai/mcp-preview-contract). This Kiro-assisted revision was prepared during the 31 August to 23 October 2026 submission window. Local preparation of a revision alone is not publication of that revision or a submitted entry. The actual repository history, immutable contribution URL, GitHub username, publication timestamp, tests, license review and submission receipt must support any completion claim. Organizer eligibility and judging decisions are not established by file timestamps or this document.

The intended contribution is the reusable runner, explicit adapter API, independent state and journal assertions, two distinct real-SDK examples, fault-sensitivity tests and standalone instructions. Its usefulness is that another developer can apply the same checks to a different preview-bound write tool without importing the primary household application. This is a description of the supplied interface and intended use, not a claim of outside adoption or an assurance of competitive results.

## License and current release scope

The source is provided under the [MIT license](LICENSE), copyright 2026 Jordan Skinner. Preserve that license and applicable third-party notices when distributing the source.

The public baseline and this revision use the same MIT license. Publication state is established by the actual repository history; this document does not itself publish a revision, authorize operational actions or establish a final hackathon submission. The package's `private` flag blocks npm registry publication. No registry release or organizer acceptance is claimed.
