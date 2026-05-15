import { SpanKind } from "@opentelemetry/api";
import {
  OBSERVATION_MCP_ALLOWED_EVENTS_TABLE_FILTER_COLUMNS,
  arrayOptionsFilter,
  booleanFilter,
  eventsTableCols,
  numberFilter,
  ObservationLevelDomain,
  ObservationTypeDomain,
  singleFilter,
  stringFilter,
  stringObjectFilter,
  stringOptionsFilter,
  timeFilter,
  type ColumnDefinition,
} from "@langfuse/shared";
import {
  getObservationsV2FromEventsTableForPublicApi,
  instrumentAsync,
} from "@langfuse/shared/src/server";
import { z } from "zod";
import {
  EncodedObservationsCursorV2,
  EncodedObservationsCursorV2String,
  encodeCursor,
} from "@/src/features/public-api/types/observations";
import { UserInputError } from "../../../core/errors";
import { defineTool } from "../../../core/define-tool";
import {
  ExpandMetadataKeysSchema,
  getMetadataExpansionForProjection,
  getProjectionFieldGroups,
  getProjectionFields,
  ObservationFieldsSchema,
  ObservationLimitSchema,
  projectObservation,
} from "../schema";

const ObservationCursorSchema =
  EncodedObservationsCursorV2String.optional().describe(
    "Cursor returned by a previous listObservations call",
  );

const OBSERVATION_MCP_FILTER_COLUMN_TYPES = new Map(
  eventsTableCols
    .filter((column) =>
      OBSERVATION_MCP_ALLOWED_EVENTS_TABLE_FILTER_COLUMNS.has(column.id),
    )
    .map((column) => [
      column.id === "traceTags" ? "tags" : column.id,
      column.type,
    ]),
);

const OBSERVATION_MCP_FILTER_COLUMN_DEFINITIONS = eventsTableCols
  .filter((column) =>
    OBSERVATION_MCP_ALLOWED_EVENTS_TABLE_FILTER_COLUMNS.has(column.id),
  )
  .map((column) => ({
    column: column.id === "traceTags" ? "tags" : column.id,
    type: column.type,
  }));

const OBSERVATION_MCP_FILTER_EXAMPLE = {
  column: "totalCost",
  operator: ">",
  value: 0.0029,
} satisfies Omit<z.infer<typeof numberFilter>, "type">;
const OBSERVATION_MCP_FILTER_EXAMPLE_WITH_TYPE = {
  type: "number",
  ...OBSERVATION_MCP_FILTER_EXAMPLE,
} satisfies z.infer<typeof numberFilter>;
const OBSERVATION_MCP_FILTER_EXAMPLE_JSON = JSON.stringify(
  OBSERVATION_MCP_FILTER_EXAMPLE,
);
const OBSERVATION_MCP_FILTER_EXAMPLE_WITH_TYPE_JSON = JSON.stringify(
  OBSERVATION_MCP_FILTER_EXAMPLE_WITH_TYPE,
);

const observationMcpFilterSchemaByType = {
  datetime: (column: string) =>
    timeFilter.omit({ type: true, column: true }).extend({
      type: z.literal("datetime").optional(),
      column: z.literal(column),
    }),
  string: (column: string) =>
    stringFilter.omit({ type: true, column: true }).extend({
      type: z.literal("string").optional(),
      column: z.literal(column),
    }),
  stringOptions: (column: string) =>
    stringOptionsFilter.omit({ type: true, column: true }).extend({
      type: z.literal("stringOptions").optional(),
      column: z.literal(column),
    }),
  arrayOptions: (column: string) =>
    arrayOptionsFilter.omit({ type: true, column: true }).extend({
      type: z.literal("arrayOptions").optional(),
      column: z.literal(column),
    }),
  number: (column: string) =>
    numberFilter.omit({ type: true, column: true }).extend({
      type: z.literal("number").optional(),
      column: z.literal(column),
    }),
  stringObject: (column: string) =>
    stringObjectFilter.omit({ type: true, column: true }).extend({
      type: z.literal("stringObject").optional(),
      column: z.literal(column),
    }),
  boolean: (column: string) =>
    booleanFilter.omit({ type: true, column: true }).extend({
      type: z.literal("boolean").optional(),
      column: z.literal(column),
    }),
} satisfies Partial<
  Record<ColumnDefinition["type"], (column: string) => z.ZodType>
>;

type ObservationMcpFilterType = keyof typeof observationMcpFilterSchemaByType;

const isObservationMcpFilterType = (
  type: string,
): type is ObservationMcpFilterType => type in observationMcpFilterSchemaByType;

const observationMcpFilterSchemas =
  OBSERVATION_MCP_FILTER_COLUMN_DEFINITIONS.flatMap(({ column, type }) =>
    isObservationMcpFilterType(type)
      ? [observationMcpFilterSchemaByType[type](column)]
      : [],
  );

const ObservationMcpFilterSchema = z
  .union(
    observationMcpFilterSchemas as [
      (typeof observationMcpFilterSchemas)[number],
      (typeof observationMcpFilterSchemas)[number],
      ...(typeof observationMcpFilterSchemas)[number][],
    ],
  )
  .describe(
    `Advanced observation filter object. Example: ${OBSERVATION_MCP_FILTER_EXAMPLE_JSON}. The explicit form ${OBSERVATION_MCP_FILTER_EXAMPLE_WITH_TYPE_JSON} is also accepted.`,
  );

const ListObservationsBaseSchema = z.object({
  fields: ObservationFieldsSchema,
  expandMetadataKeys: ExpandMetadataKeysSchema,
  limit: ObservationLimitSchema,
  cursor: ObservationCursorSchema,
  type: ObservationTypeDomain.optional(),
  name: z.string().optional(),
  userId: z.string().optional(),
  level: ObservationLevelDomain.optional(),
  traceId: z.string().optional(),
  version: z.string().optional(),
  parentObservationId: z.string().optional(),
  environment: z.union([z.array(z.string()), z.string()]).optional(),
  fromStartTime: z.iso.datetime({ offset: true }).optional(),
  toStartTime: z.iso.datetime({ offset: true }).optional(),
  filter: z
    .array(ObservationMcpFilterSchema)
    .optional()
    .describe(
      "Advanced filters. Each item must be an object with column, operator, value, and optional type. Type is inferred from getObservationFilterSchema columns when omitted.",
    ),
});

const ListObservationsInputSchema = ListObservationsBaseSchema.extend({
  filter: z
    .array(z.unknown())
    .optional()
    .superRefine((filters, ctx) => {
      if (!filters) return;

      filters.forEach((filter, index) => {
        if (
          typeof filter !== "object" ||
          filter === null ||
          Array.isArray(filter)
        ) {
          ctx.addIssue({
            code: "custom",
            path: [index],
            message: `Each filter must be an object, for example ${OBSERVATION_MCP_FILTER_EXAMPLE_JSON}. String filters are not supported.`,
          });
          return;
        }

        const filterRecord = filter as Record<string, unknown>;
        const column = filterRecord.column;
        if (typeof column !== "string") return;

        if (!OBSERVATION_MCP_FILTER_COLUMN_TYPES.has(column)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "column"],
            message: `Invalid observation filter column "${column}". Call getObservationFilterSchema for accepted columns.`,
          });
          return;
        }

        const filterWithInferredType = {
          ...filterRecord,
          type:
            filterRecord.type ??
            OBSERVATION_MCP_FILTER_COLUMN_TYPES.get(column),
        };

        const parsedFilter = singleFilter.safeParse(
          column === "tags"
            ? { ...filterWithInferredType, column: "traceTags" }
            : filterWithInferredType,
        );

        if (!parsedFilter.success) {
          ctx.addIssue({
            code: "custom",
            path: [index],
            message:
              `Invalid ${column} filter. Expected an object matching getObservationFilterSchema; for example ` +
              `${OBSERVATION_MCP_FILTER_EXAMPLE_WITH_TYPE_JSON}. ` +
              parsedFilter.error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join(", "),
          });
        }
      });
    }),
});

type ListObservationsInput = z.infer<typeof ListObservationsInputSchema>;

export const [listObservationsTool, handleListObservations] = defineTool({
  name: "listObservations",
  description: [
    "Find and review observations in the current Langfuse project, such as generations, spans, events, agent steps, and tool calls.",
    "Use filters to narrow results by trace, name, type, level, environment, time range, or advanced filter conditions. Results are paginated with an opaque cursor.",
    "",
    'By default this returns compact summary fields. Use fields: ["*"] for the full observation, or pass specific field names to limit the response size.',
  ].join("\n"),
  baseSchema: ListObservationsBaseSchema as z.ZodType<ListObservationsInput>,
  inputSchema: ListObservationsInputSchema,
  handler: async (input, context) => {
    return await instrumentAsync(
      { name: "mcp.observations.list", spanKind: SpanKind.INTERNAL },
      async (span) => {
        const projectionFields = getProjectionFields(input.fields);
        const fieldGroups = getProjectionFieldGroups(projectionFields);

        span.setAttributes({
          "langfuse.project.id": context.projectId,
          "langfuse.org.id": context.orgId,
          "mcp.api_key_id": context.apiKeyId,
          "mcp.pagination_limit": input.limit,
          "mcp.projection_fields": projectionFields.join(","),
          "mcp.field_groups": fieldGroups.join(","),
        });

        const advancedFilters = input.filter?.map((filter, index) => {
          if (
            typeof filter !== "object" ||
            filter === null ||
            Array.isArray(filter)
          ) {
            throw new UserInputError(
              `Invalid filter[${index}]: each filter must be an object, for example ${OBSERVATION_MCP_FILTER_EXAMPLE_JSON}.`,
            );
          }

          const filterRecord = filter as Record<string, unknown>;
          const column = filterRecord.column;
          if (typeof column !== "string") {
            throw new UserInputError(
              `Invalid filter[${index}]: missing string column. Call getObservationFilterSchema for accepted columns.`,
            );
          }

          const type =
            filterRecord.type ??
            OBSERVATION_MCP_FILTER_COLUMN_TYPES.get(column);
          const parsedFilter = singleFilter.safeParse(
            column === "tags"
              ? { ...filterRecord, type, column: "traceTags" }
              : { ...filterRecord, type },
          );

          if (!parsedFilter.success) {
            throw new UserInputError(
              `Invalid filter[${index}] for column "${column}". Expected an object matching getObservationFilterSchema; for example ${OBSERVATION_MCP_FILTER_EXAMPLE_WITH_TYPE_JSON}.`,
            );
          }

          return parsedFilter.data;
        });

        const items = await getObservationsV2FromEventsTableForPublicApi({
          projectId: context.projectId,
          page: 0,
          limit: input.limit,
          traceId: input.traceId,
          userId: input.userId,
          level: input.level,
          name: input.name,
          type: input.type,
          environment: input.environment,
          parentObservationId: input.parentObservationId,
          fromStartTime: input.fromStartTime,
          toStartTime: input.toStartTime,
          version: input.version,
          advancedFilters,
          cursor: input.cursor
            ? EncodedObservationsCursorV2.parse(input.cursor)
            : undefined,
          fields: fieldGroups,
          expandMetadataKeys: getMetadataExpansionForProjection(
            projectionFields,
            input.expandMetadataKeys,
          ),
        });

        const hasMore = items.length > input.limit;
        const dataToReturn = hasMore ? items.slice(0, input.limit) : items;

        const data = dataToReturn.map((item) =>
          projectObservation(
            {
              ...item,
              parentObservationId:
                item.parentObservationId === ""
                  ? null
                  : item.parentObservationId,
            },
            projectionFields,
          ),
        );

        const lastItem = dataToReturn[dataToReturn.length - 1];

        return {
          data,
          meta:
            hasMore && lastItem
              ? {
                  cursor: encodeCursor({
                    lastStartTimeTo: lastItem.startTime,
                    lastTraceId: lastItem.traceId ?? "",
                    lastId: lastItem.id,
                  }),
                }
              : {},
        };
      },
    );
  },
  readOnlyHint: true,
});
