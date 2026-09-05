export const CONFIG_FILE = ".knitto.json";
export const LOCK_FILE = ".knitto.lock";
export const TEMPLATE_MANIFEST = "template.json";

export type SourceConfig =
  | {
      type: "local";
      path: string;
    }
  | {
      type: "http";
      url: string;
      path?: string;
    }
  | {
      type: "git";
      url: string;
      path?: string;
      ref?: string;
    };

export interface ProjectConfig {
  source: SourceConfig;
  engine?: {
    package: "knitto";
    version: string;
  };
  metadata?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  exclude?: {
    rules?: string[];
    checks?: string[];
    pointers?: Record<string, string[]>;
  };
  overrides?: Record<string, Record<string, unknown>>;
  trust?: {
    hooks?: string[];
  };
}

interface BaseCheck {
  id: string;
  scope?: "root" | "workspace" | "all";
  when?: string;
}

export interface RequiredPackagesCheck extends BaseCheck {
  type: "required-packages";
  packages: Record<string, string[]>;
}

export interface UnwantedPackagesCheck extends BaseCheck {
  type: "unwanted-packages";
  packages: string[];
  allowed?: string[];
}

export interface FileRegexCheck extends BaseCheck {
  type: "file-regex";
  path: string;
  pattern: string;
  flags?: string;
  mustMatch?: boolean;
  message?: string;
  solution?: string;
}

export interface EnginesCheck extends BaseCheck {
  type: "engines";
  omit?: string[];
}

export type TemplateCheck =
  | RequiredPackagesCheck
  | UnwantedPackagesCheck
  | FileRegexCheck
  | EnginesCheck;

interface BaseRule {
  id: string;
  destination: string;
  when?: string;
  scope?: "root" | "workspace" | "all";
  target?: "project" | "root";
}

export interface FileRule extends BaseRule {
  type: "file";
  template: string;
  mode?: number;
}

export interface JsonRule extends BaseRule {
  type: "json";
  template: string;
  schema?: string;
  pointers?: string[];
  exact?: string[];
  indent?: number;
}

export interface DeleteRule extends BaseRule {
  type: "delete";
  glob?: boolean;
}

export type ParserName =
  | "text"
  | "json"
  | "json-merge"
  | "package-json"
  | "yaml"
  | "yaml-merge"
  | "ini"
  | "ini-merge"
  | "hook";

export interface ContentRule extends BaseRule {
  type: "content";
  template: string;
  parser: ParserName;
  hook?: string;
  schema?: string;
  pointers?: string[];
  exact?: string[];
  indent?: number;
  mode?: number;
}

export type TemplateRule =
  | FileRule
  | JsonRule
  | ContentRule
  | DeleteRule;

export interface TemplateManifest {
  schemaVersion: 1;
  name: string;
  engine?: {
    package: "knitto";
    version: string;
  };
  release?: {
    provider: "release-please";
    version: string;
    tagFormat: string;
  };
  extends?: string[];
  inputs?: string[];
  partials?: Record<string, string>;
  variables?: Record<string, unknown>;
  prompts?: TemplatePrompt[];
  rules: TemplateRule[];
  checks?: TemplateCheck[];
  hooks?: TemplateHook[];
}

interface BaseTemplatePrompt {
  path: `metadata.${string}` | `variables.${string}`;
  message: string;
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
  when?: string;
}

export type TemplatePrompt =
  | (BaseTemplatePrompt & {
      type: "text" | "number" | "confirm";
    })
  | (BaseTemplatePrompt & {
      type: "select";
      choices: Array<{
        value: string;
        label?: string;
      }>;
    });

export interface TemplateHook {
  id: string;
  kind: "context" | "parser" | "check";
  command: string;
  args?: string[];
}

export interface SnapshotProvenance {
  sourceType: SourceConfig["type"];
  locator: string;
  templatePath?: string;
  revision?: string;
  etag?: string;
  lastModified?: string;
}

export interface Snapshot {
  digest: string;
  directory: string;
  manifest: TemplateManifest;
  provenance: SnapshotProvenance;
}

export interface ProjectLock {
  schemaVersion: 1;
  digest: string;
  source: SourceConfig;
  engine?: {
    package: "knitto";
    version: string;
  };
  provenance: SnapshotProvenance;
  templateSchemaVersion: 1;
  resolvedAt: string;
}

export type PlanOperation =
  | {
      type: "write";
      ruleId: string;
      path: string;
      before: string | null;
      after: string;
      beforeDigest: string | null;
      mode?: number;
      jsonPatch?: JsonPatchOperation[];
    }
  | {
      type: "delete";
      ruleId: string;
      path: string;
      before: string;
      beforeDigest: string;
    };

export interface ReconciliationPlan {
  projectRoot: string;
  templateDigest: string;
  operations: PlanOperation[];
  checks: CheckResult[];
  excludedRules: string[];
  excludedPointers: Record<string, string[]>;
}

export interface CheckResult {
  id: string;
  project: string;
  title: string;
  body: string[];
  solution?: string;
}

export interface JsonPatchOperation {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  from?: string;
  value?: unknown;
}

export interface RenderContext {
  template?: {
    name: string;
    engine?: {
      package: "knitto";
      version: string;
    };
    release?: {
      provider: "release-please";
      version: string;
      tag?: string;
    };
  };
  project: {
    path: string;
    name: string;
  };
  files: Record<
    string,
    {
      text: string;
      json?: unknown;
    }
  >;
  metadata: Record<string, unknown>;
  variables: Record<string, unknown>;
  pkg: Record<string, unknown>;
  derived: Record<string, unknown>;
}

export interface ProjectUnit {
  repositoryRoot: string;
  path: string;
  relativePath: string;
  packageJson: Record<string, unknown>;
  config: ProjectConfig;
  isRoot: boolean;
  workspacePaths: string[];
}
