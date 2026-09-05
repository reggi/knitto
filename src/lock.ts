import type { ProjectLock, Snapshot, SourceConfig } from "./types.js";
import { KNITTO_PACKAGE, KNITTO_VERSION } from "./version.js";

export function createLock(
  source: SourceConfig,
  snapshot: Snapshot,
): ProjectLock {
  return {
    schemaVersion: 1,
    digest: snapshot.digest,
    source,
    engine: {
      package: KNITTO_PACKAGE,
      version: KNITTO_VERSION,
    },
    provenance: snapshot.provenance,
    templateSchemaVersion: snapshot.manifest.schemaVersion,
    resolvedAt: new Date().toISOString(),
  };
}
