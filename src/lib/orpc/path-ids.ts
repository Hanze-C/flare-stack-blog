import { ORPCError } from "@orpc/client";
import type { ConditionalSchemaConverter } from "@orpc/openapi";
import type { StandardHandlerPlugin } from "@orpc/server/standard";
import type { ApiContext } from "./context";

const CANONICAL_ID = /^[1-9][0-9]*$/;

/** Names of the `{param}` segments of a route path. */
function pathParamNames(path: string | undefined) {
  return [...(path ?? "").matchAll(/\{([^}+]+)\}/g)].map((match) => match[1]);
}

type HandlerOptions = Parameters<
  NonNullable<StandardHandlerPlugin<ApiContext>["init"]>
>[0];

/**
 * An id in a path is written as plain decimal digits with no sign, point,
 * exponent, hex prefix or padding, so every address names an id one way only.
 *
 * Smart coercion turns a numeric string into a number with `Number()`, which
 * also reads `7.4e1`, `0x4A`, `074` and ` 74` as 74. This runs before it and
 * refuses what is not the canonical form, for each path parameter whose input
 * schema is a number.
 */
export class CanonicalPathIdPlugin implements StandardHandlerPlugin<ApiContext> {
  // Each plugin puts its client interceptor first, in plugin order, so the
  // later one runs first: this has to come after SmartCoercionPlugin.
  readonly order = 10;
  readonly #converter: ConditionalSchemaConverter;
  readonly #numericParams = new WeakMap<object, Promise<Set<string>>>();

  constructor(options: { schemaConverter: ConditionalSchemaConverter }) {
    this.#converter = options.schemaConverter;
  }

  init(options: HandlerOptions) {
    options.clientInterceptors ??= [];
    options.clientInterceptors.unshift(async (interception) => {
      const { procedure, input } = interception;
      const names = pathParamNames(procedure["~orpc"].route.path);
      if (names.length === 0 || typeof input !== "object" || input === null) {
        return interception.next();
      }
      const numeric = await this.#numericParamsOf(procedure["~orpc"]);
      const issues = names.flatMap((name) => {
        const value = (input as Record<string, unknown>)[name];
        if (!numeric.has(name) || typeof value !== "string") return [];
        if (CANONICAL_ID.test(value) && Number.isSafeInteger(Number(value))) {
          return [];
        }
        return [
          {
            path: [name],
            message: `${name} must be a positive whole number written in decimal digits, such as 74.`,
          },
        ];
      });
      if (issues.length > 0) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Input validation failed",
          data: { issues },
        });
      }
      return interception.next();
    });
  }

  #numericParamsOf(definition: { inputSchema?: unknown }) {
    const schema = definition.inputSchema;
    if (typeof schema !== "object" || schema === null) {
      return Promise.resolve(new Set<string>());
    }
    let found = this.#numericParams.get(schema);
    if (!found) {
      found = Promise.resolve(
        this.#converter.convert(schema as never, { strategy: "input" }),
      ).then(([, jsonSchema]) => {
        const properties =
          typeof jsonSchema === "object" && jsonSchema.properties
            ? jsonSchema.properties
            : {};
        return new Set(
          Object.entries(properties).flatMap(([name, property]) =>
            typeof property === "object" &&
            (property.type === "integer" || property.type === "number")
              ? [name]
              : [],
          ),
        );
      });
      this.#numericParams.set(schema, found);
    }
    return found;
  }
}
