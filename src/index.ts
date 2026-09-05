export { applyPlan } from "./engine/apply.js";
export { createPlan } from "./engine/plan.js";
export { formatPlan } from "./engine/diff.js";
export {
  resolveCurrentSnapshot,
  resolveLockedSnapshot,
} from "./sources/resolve.js";
export { createLock } from "./lock.js";
export { prepareJson } from "./parsers/json.js";
export type {
  ProjectConfig,
  ProjectLock,
  ReconciliationPlan,
  Snapshot,
  SourceConfig,
  TemplateManifest,
  TemplateRule,
} from "./types.js";
