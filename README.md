# Knitto

<p align="center">
  <img src="docs/assets/knitto.png" alt="Knitto knitted K logo" width="320">
</p>

Knitto is a Unix-first declarative filesystem reconciler.

```bash
npx knitto -v
npx knitto --version
```

It renders versioned Handlebars templates into a desired directory state,
compares that state with existing files, presents a reviewable plan, and
applies changes safely.

```bash
knitto check ./project
knitto plan ./project
knitto apply ./project
```

Knitto supports:

- Whole-file generation and deletion.
- Structured JSON, YAML, INI, and package manifest reconciliation.
- Preserving unmanaged content.
- Explicit overrides and exclusions.
- Required project inputs.
- Reproducible, content-addressed template versions.
- Atomic updates and stale-change protection.
- Local, remote archive, and source-control template transports.

In shorter terms, Knitto is a template-driven tool for keeping directory trees
aligned with a declared standard: `rsync`-style convergence with Handlebars
templates and structured-file awareness.

The core engine operates on directories. Source control, pull requests, CI
systems, and future hosted services can integrate with the engine without
defining its behavior.

## Status

This repository contains an early proof of concept. It supports:

- Handlebars whole-file templates.
- Deep JSON merges, exact subtrees, template-local `{{remove}}`, and optional managed JSON Pointer fields.
- Standard RFC 6902 JSON Patch output for structured plans.
- Text, JSON, package.json, YAML, and INI parser modes.
- Root and workspace scopes with package-level configuration overlays.
- Layered manifests, partials, conditional rules, templated paths, and glob removals.
- Required-package, unwanted-package, engine, and file-content checks.
- Digest-gated Unix hooks for custom context, parsers, and checks.
- Local directories, HTTP archives, Git HTTPS, and Git SSH template sources.
- Content-addressed SHA-256 template snapshots and an XDG cache.
- Explicit project variables, rule exclusions, field exclusions, and field overrides.
- Read-only checks and plans.
- Stale-plan detection, atomic file replacement, and rollback after application errors.

## Template Structure

A template is an ordinary directory:

```text
template/
├── template.json
└── files/
    ├── LICENSE.hbs
    └── package.managed.json.hbs
```

The manifest defines stable rules and their ownership:

```json
{
  "schemaVersion": 1,
  "name": "node-service",
  "inputs": [
    "package.json"
  ],
  "variables": {
    "license": "MIT"
  },
  "rules": [
    {
      "id": "license",
      "type": "file",
      "template": "files/LICENSE.hbs",
      "destination": "LICENSE"
    },
    {
      "id": "package-metadata",
      "type": "content",
      "parser": "package-json",
      "template": "files/package.managed.json.hbs",
      "destination": "package.json",
      "exact": [
        "/repository"
      ]
    }
  ]
}
```

A whole-file rule owns the complete destination. Structured parsers deeply merge rendered content by default. `exact` or an optional pointer allowlist narrows or strengthens ownership, while `{{remove}}` expresses property removal inside the template.

Whole-file deletion is never inferred. A template must declare a `delete` rule to remove a file.

## Handlebars Context

Templates receive a platform-neutral context:

```json
{
  "project": {
    "path": "/projects/example",
    "name": "example"
  },
  "files": {
    "package.json": {
      "text": "{ ... }",
      "json": {
        "name": "example"
      }
    }
  },
  "metadata": {},
  "variables": {}
}
```

For example:

```handlebars
{
  "name": {{json files.[package.json].json.name}},
  "license": {{json variables.license}},
  "repository": {
    "type": "git",
    "url": {{json metadata.url}}
  }
}
```

The built-in deterministic helpers include `json`, `obj`, `extGlob`, `join`, `pluck`, `quote`, `last`, `lowercase`, `uppercase`, `basename`, `default`, `appendMissingLines`, `lte`, `eq`, and `semverRangeMajor`. `appendMissingLines` remains supported for compatibility with immutable template snapshots even when newer templates use authoritative whole-file rules. Rendering uses strict Handlebars mode with prototype access disabled.

Templates register partials through an explicit name-to-file map:

```json
{
  "partials": {
    "managedScripts": "files/_managed-scripts.hbs",
    "licenseHeader": "files/shared/license-header.hbs"
  }
}
```

Names are arbitrary and are not derived from filenames. `{{> managedScripts}}` resolves exactly to the file assigned to the `managedScripts` key.

## Conditional Structured Property Deletion

JSON and YAML templates define desired values and deletions in one place. `{{remove}}` renders an internal marker that structured parsers consume before writing; it never appears in the destination file.

```handlebars
{
  "license": "MIT",
  "type": {{#if esm}}"module"{{else}}{{remove}}{{/if}},
  "scripts": {
    "lint": "eslint .",
    "format": {{#if prettier}}"prettier . --check"{{else}}{{remove}}{{/if}},
    "template-copy": {{remove}}
  },
  "repository": {
    "type": "git",
    "url": {{json metadata.url}}
  }
}
```

```json
{
  "id": "package-json",
  "type": "content",
  "parser": "package-json",
  "template": "package-json.hbs",
  "destination": "package.json",
  "exact": [
    "/repository"
  ]
}
```

- The rendered object is deeply merged into the existing document.
- `exact` replaces those subtrees completely, removing unmentioned properties.
- `{{remove}}` removes the property at its rendered location.
- Handlebars conditionals decide whether a property receives a value or is deleted.
- Pointer exclusions prevent the corresponding exact, merge, or `{{remove}}` operation.
- Project overrides are applied after template reconciliation.

When `prettier` is false, planning produces standard RFC 6902 operations:

```json
[
  {
    "op": "remove",
    "path": "/scripts/format"
  },
  {
    "op": "remove",
    "path": "/scripts/template-copy"
  },
  {
    "op": "remove",
    "path": "/standard"
  },
  {
    "op": "remove",
    "path": "/templateVersion"
  }
]
```

To enforce that an entire object has no unmentioned properties, place its pointer in `exact`. For example, `"/repository"` means the rendered `repository` object is authoritative. An empty pointer, `""`, makes the complete rendered document authoritative.

JSON Schema remains available through the optional `schema` property for validation and advanced closure rules such as `additionalProperties: false`. It is not required for ordinary merges and deletions.

The JSON and YAML reconcilers use JSON Pointer for exact ownership and project exceptions, while plans emit standard JSON Patch operations over the parsed document. `{{remove}}` is an authoring convenience translated into an RFC 6902 `remove` operation.

## Typed Parsers

Rules can select how rendered content is parsed and reconciled:

| Parser | Behavior |
| --- | --- |
| `text` | Replace the complete file |
| `json` | Replace the complete JSON document |
| `json-merge` | Deeply merge objects; source arrays replace target arrays |
| `package-json` | Deep merge and serialize common package fields in conventional order |
| `yaml` | Replace a YAML document with JSON-parity exact, removal, exclusion, override, schema, and patch semantics |
| `yaml-merge` | Deeply merge YAML data with JSON-parity exact, removal, exclusion, override, schema, and patch semantics |
| `ini` | Replace an INI document |
| `ini-merge` | Deeply merge INI data |
| `hook` | Delegate preparation to an explicitly trusted Unix hook |

YAML behavior is selected by the rule parser, not the destination extension, so `.yml` and `.yaml` files have identical support.

Every parser feeds the same file plan and stale-write protection. Structured JSON and YAML parsers attach their RFC 6902 operations to JSON plan output.

## Layered Templates

A template manifest can extend other manifests in the same immutable snapshot:

```json
{
  "schemaVersion": 1,
  "name": "acme-node-service",
  "extends": [
    "base/node/template.json",
    "base/open-source/template.json"
  ],
  "variables": {
    "codeowner": "@acme/platform"
  },
  "rules": []
}
```

Inputs, partials, variables, checks, and hooks are combined. A later rule, check, or hook replaces an earlier entry with the same stable ID.

## Workspaces and Scopes

Node workspaces are discovered from the root `package.json`. Rules and checks can run against:

- `root`: only the repository root.
- `workspace`: every selected workspace.
- `all`: the root and every workspace.

Rules normally write relative to the package being evaluated. `target: "root"` lets a workspace generate a repository-root file:

```json
{
  "id": "workspace-ci",
  "type": "file",
  "scope": "workspace",
  "target": "root",
  "template": "files/ci.yml.hbs",
  "destination": ".github/workflows/ci-{{pkgNameFs}}.yml"
}
```

Root and workspace `package.json` files may contain `knitto` configuration. Workspace values overlay root values for variables, metadata, exclusions, and overrides.

Derived Handlebars values include `isRoot`, `isWorkspace`, `isMono`, `isRootMono`, `repoDir`, `moduleDir`, `pkgName`, `pkgNameFs`, `pkgPath`, `workspacePaths`, `workspaceGlobs`, `isPrivate`, `isPublic`, `esm`, `cjsExt`, and `deleteJsExt`.

## Policy Checks

Templates may define checks independent of generated files:

```json
{
  "checks": [
    {
      "id": "required-tooling",
      "type": "required-packages",
      "scope": "all",
      "packages": {
        "devDependencies": [
          "typescript@^5",
          "eslint@^9"
        ]
      }
    },
    {
      "id": "unwanted-tooling",
      "type": "unwanted-packages",
      "packages": [
        "standard"
      ]
    },
    {
      "id": "changelog-heading",
      "type": "file-regex",
      "path": "CHANGELOG.md",
      "pattern": "^# Changelog\\\\n\\\\n#",
      "solution": "Reformat the changelog heading."
    },
    {
      "id": "dependency-engines",
      "type": "engines"
    }
  ]
}
```

Checks support `scope` and Handlebars `when` conditions. Projects can explicitly exclude a check by stable ID.

## Trusted Unix Hooks

Declarative templates are the default. A template may optionally declare executable hooks for custom context derivation, parser behavior, or checks:

```json
{
  "hooks": [
    {
      "id": "derive-project-data",
      "kind": "context",
      "command": "hooks/derive-project-data"
    }
  ]
}
```

Hooks exchange JSON over stdin and stdout. They do not run until the exact template digest is trusted:

```bash
knitto source trust ./project
```

Trust is recorded in `.knitto.json` as a SHA-256 digest. A changed template produces a different digest and must be trusted again before its hooks can execute.

## Project Configuration

Each managed project contains a human-edited `.knitto.json`:

```json
{
  "source": {
    "type": "git",
    "url": "git@github.com:acme/repository-templates.git",
    "path": "templates/node-service",
    "ref": "main"
  },
  "metadata": {
    "url": "https://example.com/acme/service",
    "issuesUrl": "https://example.com/acme/service/issues"
  },
  "variables": {
    "license": "MIT"
  },
  "exclude": {
    "rules": [],
    "checks": [],
    "pointers": {
      "package-metadata": [
        "/homepage"
      ]
    }
  },
  "overrides": {
    "package-metadata": {
      "/repository/url": "https://example.com/custom/service"
    }
  }
}
```

Projects can diverge explicitly:

- `variables` replace declared template variable defaults.
- `exclude.rules` opts out of complete rules.
- `exclude.pointers` opts out of selected fields in JSON rules.
- `overrides` replaces a managed JSON value for one project.

Unknown variables, rules, and pointers fail validation. Local edits to managed content remain drift unless the project declares an exclusion or override.

## Template Revisions

Knitto does not require template authors to publish packages, tags, or
releases. Templates and consumers without release configuration continue to
use branches, commits, local directories, or archives as before. Every resolved
template directory becomes an immutable snapshot identified by a digest:

```text
sha256:58eea85c...
```

`.knitto.json` describes where the template comes from. Generated `.knitto.lock` records the exact content digest and source provenance:

```json
{
  "schemaVersion": 1,
  "digest": "sha256:58eea85c...",
  "source": {
    "type": "git",
    "url": "git@github.com:acme/repository-templates.git",
    "path": "templates/node-service",
    "ref": "main"
  },
  "engine": {
    "package": "knitto",
    "version": "0.0.1"
  },
  "provenance": {
    "sourceType": "git",
    "locator": "git@github.com:acme/repository-templates.git",
    "templatePath": "templates/node-service",
    "revision": "89ca41..."
  },
  "templateSchemaVersion": 1,
  "resolvedAt": "2026-09-04T05:00:00.000Z"
}
```

The SHA-256 digest is authoritative. A Git commit, HTTP ETag, or branch name is provenance, not the cross-transport version identity.

The optional `engine` field declares the minimum compatible public npm version.
Knitto accepts a running engine at or above that version within the same major
release line. Generated locks record the exact engine version that produced
them. Newly initialized projects include the current minimum; older
configurations without it remain supported.

### Opt-in template releases

A template may declare Release Please metadata:

```json
{
  "schemaVersion": 1,
  "name": "node-policy",
  "engine": {
    "package": "knitto",
    "version": "1.0.0"
  },
  "release": {
    "provider": "release-please",
    "version": "2.3.0",
    "tagFormat": "policy-v{version}"
  },
  "rules": []
}
```

`tagFormat` is template-specific and must contain `{version}`. Release Please
updates `release.version` on its release pull request and creates the matching
tag after merge. Consumers pin that exact tag in `.knitto.json`; reverting the
consumer update restores both the prior tag and lock.

Release Please uses `0.0.0` as bootstrap metadata before the first release.
Knitto treats that version as unreleased, so Git consumers may continue using
the template's branch. Immutable-tag enforcement begins when
`release.version` becomes the first published version.

Move an existing Git consumer to a released tag before planning or applying:

```bash
npx knitto@1.0.0 source pin ./project --ref policy-v2.3.0
npx knitto@1.0.0 apply ./project --update
```

`source pin` validates that the selected revision declares the requested tag
and updates the consumer's minimum engine version to the version required by
that template. The second command may use that version or a newer compatible
engine within the same major line. Templates that do not declare `release`, and
templates still bootstrapping at `0.0.0`, do not require a release tag.

Attach an existing project to a template without applying its files:

```bash
knitto source set https://github.com/reggi/template-railway
```

GitHub repository URLs are inferred as Git sources with `.knitto` as the
default template path. If the template has a published release, Knitto
automatically selects its immutable tag and required engine. Existing metadata,
variables, exclusions, and overrides are preserved; a stale lock is removed so
the next `check`, `plan`, or `apply` resolves the newly selected source.

Snapshots are cached under:

```text
${XDG_CACHE_HOME:-$HOME/.cache}/knitto/snapshots/
```

Locked checks can therefore remain reproducible and work from cache after initial resolution.

## Source Types

### Local directory

```json
{
  "source": {
    "type": "local",
    "path": "../repository-templates/node-service"
  }
}
```

### HTTP archive

The URL must return a tar or tar-gzip archive containing the template manifest:

```json
{
  "source": {
    "type": "http",
    "url": "https://templates.example.com/node-service/latest.tar.gz"
  }
}
```

An optional `path` selects a template beneath the extracted archive root.

### Git over HTTPS

```json
{
  "source": {
    "type": "git",
    "url": "https://example.com/acme/repository-templates.git",
    "path": "templates/node-service",
    "ref": "main"
  }
}
```

### Git over SSH

```json
{
  "source": {
    "type": "git",
    "url": "git@example.com:acme/repository-templates.git",
    "path": "templates/node-service",
    "ref": "main"
  }
}
```

SSH sources use the existing Unix SSH agent and Git configuration. Knitto does not store private keys.

All source types resolve through the same validation, canonicalization, hashing, caching, planning, and application pipeline.

## Commands

Scaffold a new self-managed template:

```bash
knitto init-template ./my-template
```

This creates:

```text
my-template/
├── .knitto.json
└── .knitto/
    ├── template.json
    └── files/
```

The generated `.knitto.json` points to the local `.knitto` source, and
`template.json` starts with an empty `rules` array. The template name defaults
to the target directory name and can be set explicitly:

```bash
knitto init-template ./my-template --name shared-node-policy
```

The command refuses to replace an existing `.knitto` directory or
`.knitto.json`.

Initialize a project interactively:

```bash
knitto init ./project
```

Or initialize non-interactively:

```bash
knitto init ./project \
  --type git \
  --source git@example.com:acme/repository-templates.git \
  --template-path templates/node-service \
  --ref main
```

All reconciliation commands validate every referenced template file, partial,
schema, executable hook, and parser-hook reference before planning or applying
changes. Use `check` to additionally validate the project configuration, any
existing lock, and assert consumer compliance against its selected snapshot:

```bash
knitto check ./project
knitto check ./project --json
knitto check ./project --quiet
```

Validation covers template assets even when their rules are currently disabled
by a `when` condition. Use the newest configured source instead of the lock:

```bash
knitto check ./project --update
```

`check` exits with status `1` when writes, deletions, or check violations are
planned.

Display the changes required by the locked snapshot:

```bash
knitto plan ./project
```

When `.knitto.json` exists but no lock has been created yet, `plan`
resolves the configured source as a bootstrap snapshot. The first successful
`apply` writes `.knitto.lock`; later commands use the pinned revision
unless `--update` is supplied.

A starter repository may bootstrap from an embedded local template and include
a rule that rewrites only `.knitto.json#source` to a canonical remote
source before deleting the embedded template. When an apply changes the source,
the generated lock records the post-apply source configuration.

Templates may declare prompts for arbitrary required non-secret project
settings under `metadata.*` or `variables.*`. Every command resolves the
requirements of its selected template revision, so a later `plan --update` can
request newly introduced information before reconciliation proceeds. Answers
are saved to `.knitto.json`. Text, numeric, confirmation, and select
prompts are supported, and `when` may conditionally enable a requirement.
Prompt defaults may be Handlebars templates, but
derived values are never implicit engine behavior. A template may explicitly
opt into a directory-derived package-name default with:

```json
{
  "path": "metadata.name",
  "type": "text",
  "message": "Package name",
  "default": "{{project.name}}",
  "required": true,
  "when": "{{#unless (eq project.name \"template-source\")}}true{{/unless}}"
}
```

For automation or non-interactive initialization, repeat `--set`:

```bash
knitto plan ./project --update \
  --set metadata.name=my-service \
  --set variables.region=iad
```

Template inputs are for non-secret configuration. Credentials and tokens must
not be stored as prompt answers.

LLMs and CI should inspect requirements before planning:

```bash
knitto inputs --update --json
```

The response identifies the selected template digest and every declared input,
including its path, type, message, choices, configured value or default,
`willPrompt`, and `missingRequired`. This lets automation construct explicit
`--set path=value` arguments without discovering prompts through an
interactive command.

CI never accepts prompt defaults or silently skips unresolved inputs. If an
enabled input is not already configured and was not explicitly provided with
`--set`, Knitto fails with instructions for creating a manual pull
request. From a local checkout, either collect and save the values
interactively:

```bash
knitto plan --update
```

or populate every value explicitly:

```bash
knitto plan --update \
  --set 'metadata.name=<value>' \
  --set 'metadata.description=<value>'
```

Commit the resulting `.knitto.json` change through a pull request before
retrying CI.

Human-readable plans begin with the project, abbreviated template digest,
compliance status, change and policy counts, and exclusions. Each operation
then identifies its action, destination, owning rule, line summary, optional
structured patch paths, and unified diff. Use `--json` for the complete
machine-readable plan.

Resolve the newest source contents and preview an update without advancing the lock:

```bash
knitto plan ./project --update
```

Apply the locked snapshot:

```bash
knitto apply ./project
```

Apply the newest source snapshot and advance the lock only after successful writes:

```bash
knitto apply ./project --update
```

`apply` calculates the plan and applies it atomically in the same invocation.
CI can therefore use `knitto apply --update` as its single
reconciliation step before creating a pull request from the resulting changes.

Inspect the locked and current source revisions:

```bash
knitto source inspect ./project
knitto source inspect ./project --json
```

Trust executable hooks from the currently locked template revision:

```bash
knitto source trust ./project
```

## Releases

The first public version is `0.0.1`. Release Please manages version updates,
`CHANGELOG.md`, release pull requests, and tags from Conventional Commits on
`main`. When a release is created, the workflow builds that exact version,
stages it through npm, and leaves final publication behind npm's human 2FA
approval boundary.

The workflow uses `GITHUB_TOKEN` by default. Set a `RELEASE_PLEASE_TOKEN`
repository secret to a fine-grained token with contents and pull-request write
access when release pull requests must trigger other GitHub Actions workflows.
Publishing requires npm trusted publishing or an `NPM_TOKEN` repository secret.

## Testing

The high-level CLI usage suite runs Knitto as a subprocess against isolated
temporary templates and projects:

```bash
npm run test:integration
```

It covers the local initialize-plan-check-apply lifecycle, structured-file
preservation, deletion, drift detection, immutable Git tag pinning, engine
pinning, lock creation and advancement, required CI inputs, workspace targets,
invalid inactive template assets, and executable-hook trust. The full
`npm test` command includes this suite. CI builds Knitto and runs the same suite
again through `dist/src/cli.js` to verify the compiled executable boundary:

```bash
npm run build
npm run test:integration:dist
```

## Railway Proof of Concept

[`examples/railway`](./examples/railway) contains:

- A shared Railway Node service template.
- The current `package.json` shapes from `railway-vikunja` and `railway-plausible`.
- A field-level opt-out for the Vikunja homepage.
- An explicit Plausible homepage override.
- A whole-file license rule.
- Legacy `standard`, `templateVersion`, formatter, template-copy, and repository fields that demonstrate pointer-driven property deletion.
- An RFC 6902 patch attached to the `package.json` plan operation.
- A compact `exact` policy plus conditional `{{remove}}` values; no duplicate package schema or second conditional is required.

`examples/railway/standards-template` is a deliberately small template for the
real `railway-plausible` and `railway-vikunja` repositories. It ensures both
`.DS_Store` and the generated `railway-plan.json` are ignored.

The `.gitignore` rule is authoritative, so both repositories converge to the
same ordering and newline layout rather than merely containing the same
entries. `railway-plan.json` may contain account-specific Railway details and
must remain local.

The same standards template owns the complete `package.json` shape for these
private Railway IaC repositories. It derives `name` from the repository
directory and standardizes ESM, Node.js 22, Railway commands, formatting,
package ordering, quality checks, and exact development dependency versions.
It intentionally omits a publish version and production dependencies.

It also owns `tsconfig.json` as a complete file. Both projects use NodeNext,
strict checking, no emit, JSON module resolution, ES2022 output targeting,
explicit Node.js types, and only compile `.railway/**/*.ts`.

The template also removes `.github/**`. These projects consume one shared local
template and intentionally do not carry repository-specific GitHub workflows
or metadata. Applying glob deletions prunes empty parent directories, so the
`.github` directory itself disappears after its final file is removed.

`.railway/README.md` is also explicitly absent. Railway-specific documentation
belongs in the repository root README, keeping the `.railway` directory limited
to generated metadata and executable infrastructure configuration.

After applying package dependency changes, regenerate the project lockfile with
`npm install --package-lock-only --ignore-scripts`. Lockfiles contain resolved
package-manager output and are not rendered as Handlebars templates.

After building the CLI:

```bash
node dist/src/cli.js init examples/railway/projects/railway-vikunja
node dist/src/cli.js init examples/railway/projects/railway-plausible
node dist/src/cli.js plan examples/railway/projects/railway-vikunja
node dist/src/cli.js plan examples/railway/projects/railway-plausible
```

The checked-in example configurations are intentionally unlocked. When a project already has `.knitto.json`, `init` validates its configured source and creates the initial lock without replacing the configuration.

The same template can be applied to actual local checkouts by adding project-specific `.knitto.json` files and running `plan` before `apply`. No Git remote or pull-request behavior is required.

## Development

Install dependencies:

```bash
npm install
```

Available validation commands:

```bash
npm run check
npm test
npm run build
```

The GitHub Actions workflow calls these package scripts; validation logic is not hidden in workflow YAML.

## Future Central Registry

A hosted or self-hosted registry can implement the HTTP source contract without changing the engine:

1. Accept a template directory or connect an external source.
2. Validate it and create an immutable content-addressed snapshot.
3. Expose mutable channels such as `stable` or `next` that resolve to digests.
4. Track which locked digest each project reports.
5. Coordinate update plans across many machines and projects.

The registry would improve discovery, history, access control, adoption reporting, and fleet coordination. It would not be required for local reconciliation.

GitHub, GitLab, CI, and pull-request integrations can likewise consume operation plans as adapters. The underlying primitive remains:

> Resolve a template snapshot, render it with project context, calculate a plan, and safely reconcile a Unix directory.
