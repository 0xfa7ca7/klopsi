import { EXIT_CODES, KlopsiError } from "@klopsi/domain";

/**
 * Supported named query parameter types. Values always travel as their exact
 * command-line text and are converted to DuckDB values only when bound to a
 * prepared statement; they are never interpolated into SQL text.
 *
 * - `varchar` (default): any well-formed text.
 * - `int`: a decimal integer in the signed 64-bit range, bound as BIGINT.
 * - `double`: a finite decimal number, bound as DOUBLE.
 * - `bool`: `true` or `false`, bound as BOOLEAN.
 * - `date`: an ISO `YYYY-MM-DD` calendar date (years 0001-9999), bound as DATE.
 */
export const QUERY_PARAMETER_TYPES = ["varchar", "int", "double", "bool", "date"] as const;
export type QueryParameterType = (typeof QUERY_PARAMETER_TYPES)[number];

export interface QueryParameter {
  readonly name: string;
  readonly type: QueryParameterType;
  readonly value: string;
}

export const MAX_QUERY_PARAMETERS = 64;
export const MAX_QUERY_PARAMETER_VALUE_BYTES = 64 * 1024;
export const QUERY_PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INTEGER_PATTERN = /^[+-]?\d+$/u;
const DOUBLE_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MS_PER_DAY = 86_400_000;

function invalid(message: string, context?: Readonly<Record<string, unknown>>): KlopsiError {
  return new KlopsiError({
    code: "QUERY_PARAM_INVALID",
    message,
    exitCode: EXIT_CODES.INVALID_INPUT,
    suggestion: `Use --param name=value or name:type=value with type ${QUERY_PARAMETER_TYPES.join(", ")}.`,
    ...(context === undefined ? {} : { context }),
  });
}

function isParameterType(value: string): value is QueryParameterType {
  return (QUERY_PARAMETER_TYPES as readonly string[]).includes(value);
}

/** Days since 1970-01-01 for a validated ISO date, or undefined when invalid. */
export function queryParameterDateDays(value: string): number | undefined {
  const match = DATE_PATTERN.exec(value);
  if (match === null) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  return Math.round(date.getTime() / MS_PER_DAY);
}

function validValue(type: QueryParameterType, value: string): boolean {
  switch (type) {
    case "varchar":
      return true;
    case "int": {
      if (!INTEGER_PATTERN.test(value)) return false;
      const parsed = BigInt(value);
      return parsed >= INT64_MIN && parsed <= INT64_MAX;
    }
    case "double":
      return DOUBLE_PATTERN.test(value) && Number.isFinite(Number(value));
    case "bool":
      return value === "true" || value === "false";
    case "date":
      return queryParameterDateDays(value) !== undefined;
  }
}

function validateParameter(parameter: QueryParameter): QueryParameter {
  const { name, type, value } = parameter;
  if (typeof name !== "string" || !QUERY_PARAMETER_NAME_PATTERN.test(name))
    throw invalid(
      "Query parameter names must start with a letter or underscore and contain at most 63 letters, digits, or underscores.",
    );
  if (typeof type !== "string" || !isParameterType(type))
    throw invalid(`Query parameter '${name}' has an unsupported type.`, {
      name,
      supportedTypes: QUERY_PARAMETER_TYPES,
    });
  if (typeof value !== "string" || !value.isWellFormed())
    throw invalid(`Query parameter '${name}' must be well-formed text.`, { name, type });
  if (Buffer.byteLength(value, "utf8") > MAX_QUERY_PARAMETER_VALUE_BYTES)
    throw new KlopsiError({
      code: "QUERY_PARAM_LIMIT",
      message: `Query parameter '${name}' exceeds the ${MAX_QUERY_PARAMETER_VALUE_BYTES}-byte value limit.`,
      exitCode: EXIT_CODES.INVALID_INPUT,
      context: { name, maximumBytes: MAX_QUERY_PARAMETER_VALUE_BYTES },
    });
  if (!validValue(type, value))
    throw invalid(`Query parameter '${name}' is not a valid ${type} value.`, { name, type });
  return { name, type, value };
}

/**
 * Parses one `--param` argument: `name=value` (VARCHAR) or `name:type=value`.
 * The first `=` separates the declaration from the value, so values may contain `=`.
 */
export function parseQueryParameter(text: string): QueryParameter {
  const separator = text.indexOf("=");
  if (separator < 0) throw invalid("Query parameters must use name=value or name:type=value.");
  const declaration = text.slice(0, separator);
  const value = text.slice(separator + 1);
  const colon = declaration.indexOf(":");
  const name = colon < 0 ? declaration : declaration.slice(0, colon);
  const type = colon < 0 ? "varchar" : declaration.slice(colon + 1);
  if (!QUERY_PARAMETER_NAME_PATTERN.test(name))
    throw invalid(
      "Query parameter names must start with a letter or underscore and contain at most 63 letters, digits, or underscores.",
    );
  if (!isParameterType(type))
    throw invalid(`Query parameter '${name}' has an unsupported type.`, {
      name,
      supportedTypes: QUERY_PARAMETER_TYPES,
    });
  return validateParameter({ name, type, value });
}

/**
 * Validates a complete parameter list: count, identifiers, types, values, and
 * case-insensitive uniqueness (DuckDB resolves `$name` case-insensitively).
 */
export function validateQueryParameters(
  parameters: readonly QueryParameter[],
): readonly QueryParameter[] {
  if (parameters.length > MAX_QUERY_PARAMETERS)
    throw new KlopsiError({
      code: "QUERY_PARAM_LIMIT",
      message: `At most ${MAX_QUERY_PARAMETERS} query parameters are allowed.`,
      exitCode: EXIT_CODES.INVALID_INPUT,
      context: { maximum: MAX_QUERY_PARAMETERS, received: parameters.length },
    });
  const seen = new Set<string>();
  return parameters.map((parameter) => {
    const validated = validateParameter(parameter);
    const key = validated.name.toLowerCase();
    if (seen.has(key))
      throw new KlopsiError({
        code: "QUERY_PARAM_DUPLICATE",
        message: `Query parameter '${validated.name}' is given more than once (names are case-insensitive).`,
        exitCode: EXIT_CODES.INVALID_INPUT,
        context: { name: validated.name },
      });
    seen.add(key);
    return validated;
  });
}
