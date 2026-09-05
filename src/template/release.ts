import type { TemplateManifest } from "../types.js";

export const UNRELEASED_TEMPLATE_VERSION = "0.0.0";

export function templateReleaseTag(
  release: TemplateManifest["release"],
): string | undefined {
  if (!release || release.version === UNRELEASED_TEMPLATE_VERSION) {
    return undefined;
  }
  return release.tagFormat.replaceAll("{version}", release.version);
}
