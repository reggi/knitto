import path from "node:path";
import Handlebars from "handlebars";
import { minVersion } from "semver";
import { KnittoError } from "../errors.js";
import type { RenderContext } from "../types.js";

export const DELETE_SENTINEL = "__KNITTO_DELETE__";

export interface TemplatePartial {
  name: string;
  contents: string;
}

function createHandlebars(partials: TemplatePartial[]): typeof Handlebars {
  const handlebars = Handlebars.create();

  handlebars.registerHelper("json", (value: unknown) => {
    return new handlebars.SafeString(JSON.stringify(value));
  });
  handlebars.registerHelper("remove", () => {
    return new handlebars.SafeString(JSON.stringify(DELETE_SENTINEL));
  });
  handlebars.registerHelper("obj", (options: { hash: Record<string, unknown> }) =>
    options.hash,
  );
  handlebars.registerHelper("extGlob", (values: unknown[]) =>
    `{${values.map(String).join(",")}}`,
  );
  handlebars.registerHelper(
    "join",
    (values: unknown[], separator: unknown) =>
      values.join(typeof separator === "string" ? separator : ", "),
  );
  handlebars.registerHelper("pluck", (values: unknown[], key: string) =>
    values.map((value) =>
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined,
    ),
  );
  handlebars.registerHelper("quote", (values: unknown[]) =>
    values.map((value) => `'${String(value)}'`),
  );
  handlebars.registerHelper("last", (values: unknown[]) => values.at(-1));
  handlebars.registerHelper("lowercase", (value: unknown) =>
    String(value).toLowerCase(),
  );
  handlebars.registerHelper("uppercase", (value: unknown) =>
    String(value).toUpperCase(),
  );
  handlebars.registerHelper("basename", (value: unknown) =>
    path.basename(String(value)),
  );
  handlebars.registerHelper(
    "default",
    (value: unknown, fallback: unknown) => value ?? fallback,
  );
  handlebars.registerHelper(
    "appendMissingLines",
    (value: unknown, ...valuesAndOptions: unknown[]) => {
      const values = valuesAndOptions.slice(0, -1).map(String);
      const text = value === undefined || value === null ? "" : String(value);
      const newline = text.includes("\r\n") ? "\r\n" : "\n";
      const existing = new Set(text.split(/\r?\n/));
      const missing = values.filter((line) => !existing.has(line));
      if (missing.length === 0) return new handlebars.SafeString(text);
      const separator = text.length === 0 || text.endsWith(newline) ? "" : newline;
      return new handlebars.SafeString(
        `${text}${separator}${missing.join(newline)}${newline}`,
      );
    },
  );
  handlebars.registerHelper("lte", (left: unknown, right: unknown) =>
    Number(left) <= Number(right),
  );
  handlebars.registerHelper("eq", (left: unknown, right: unknown) =>
    Object.is(left, right),
  );
  handlebars.registerHelper("semverRangeMajor", (value: unknown) => {
    const version = minVersion(String(value));
    if (!version) {
      throw new Error(`Invalid semantic version range: ${String(value)}`);
    }
    return version.major;
  });
  for (const partial of partials) {
    handlebars.registerPartial(partial.name, partial.contents);
  }

  return handlebars;
}

export function renderTemplate(
  template: string,
  context: RenderContext,
  name: string,
  partials: TemplatePartial[] = [],
): string {
  try {
    const handlebars = createHandlebars(partials);
    const compiled = handlebars.compile(template, {
      strict: true,
      noEscape: true,
      preventIndent: true,
    });
    return compiled(
      {
        ...context.variables,
        ...context.derived,
        ...context,
      },
      {
      allowProtoMethodsByDefault: false,
      allowProtoPropertiesByDefault: false,
      },
    );
  } catch (error) {
    throw new KnittoError(`Unable to render template: ${name}`, "TEMPLATE", {
      cause: error,
    });
  }
}
