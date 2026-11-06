declare const providerIdBrand: unique symbol;
declare const datasetIdBrand: unique symbol;
declare const resourceIdBrand: unique symbol;
declare const canonicalReferenceBrand: unique symbol;

export type ProviderId = string & { readonly [providerIdBrand]: "ProviderId" };
export type DatasetId = string & { readonly [datasetIdBrand]: "DatasetId" };
export type ResourceId = string & { readonly [resourceIdBrand]: "ResourceId" };
export type CanonicalReference = string & {
  readonly [canonicalReferenceBrand]: "CanonicalReference";
};
export type DataFormat = "csv" | "tsv" | "json" | "ndjson" | "xlsx" | "parquet";

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
}
export interface License {
  readonly id?: string;
  readonly name: string;
  readonly url?: string;
}
interface ProviderMetadata {
  readonly raw: Readonly<Record<string, unknown>>;
}
export interface Resource {
  readonly id: ResourceId;
  readonly datasetId: DatasetId;
  readonly providerId: ProviderId;
  readonly title: string;
  readonly url: string;
  readonly reference?: CanonicalReference;
  readonly description?: string;
  readonly format?: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
  readonly modifiedAt?: string;
  readonly providerMetadata?: ProviderMetadata;
}
export interface DatasetSummary {
  readonly id: DatasetId;
  readonly providerId: ProviderId;
  readonly title: string;
  readonly reference?: CanonicalReference;
  readonly description?: string;
  readonly organization?: Organization;
  readonly license?: License;
  readonly tags?: readonly string[];
  readonly modifiedAt?: string;
  readonly resourceCount?: number;
  readonly providerMetadata?: ProviderMetadata;
}
export interface Dataset extends DatasetSummary {
  readonly resources: readonly Resource[];
}
export interface SearchFilters {
  readonly organization?: string;
  readonly tags?: readonly string[];
  readonly formats?: readonly string[];
  readonly license?: string;
  readonly modifiedAfter?: string;
  readonly modifiedBefore?: string;
}
export interface SearchSort {
  readonly field: string;
  readonly direction: "asc" | "desc";
}
export interface SearchQuery {
  readonly text?: string;
  readonly filters?: SearchFilters;
  readonly sort?: readonly SearchSort[];
  readonly limit?: number;
  readonly offset?: number;
}
export interface SearchPage {
  readonly items: readonly DatasetSummary[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly nextOffset?: number;
}
export type ProviderCapability =
  "search" | "dataset" | "resource" | "dataset-resources" | "resolve-resource";
export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly name: string;
  readonly capabilities: readonly ProviderCapability[];
  readonly description?: string;
  readonly homepage?: string;
}
export type ResolvedResourceKind = "file" | "page" | "api" | "archive" | "service";
export interface NextAction {
  readonly action: string;
  readonly argv: readonly string[];
  readonly reason?: string;
}
export type ResourceAccessOperation =
  | "inspect"
  | "preview"
  | "schema"
  | "validate"
  | "query"
  | "convert"
  | "download"
  | "layers"
  | "count"
  | "export"
  | "open";
export interface ResourceAccessDescriptor {
  readonly input: string;
  readonly kind: ResolvedResourceKind | "local";
  readonly declaredFormat?: string;
  readonly detectedFormat?: string;
  readonly protocol?: "wfs" | "wms" | "unknown";
  readonly version?: string;
  readonly operations: readonly ResourceAccessOperation[];
  readonly selections?: Readonly<Record<string, readonly string[]>>;
  readonly limitations: readonly string[];
  readonly nextActions: readonly NextAction[];
}
export interface ResolvedResource {
  readonly resource: Resource;
  readonly kind: ResolvedResourceKind;
  readonly url: string;
  readonly reference?: CanonicalReference;
  readonly filename?: string;
  readonly format?: string;
  readonly mediaType?: string;
  readonly headers?: Readonly<Record<string, string>>;
}
export interface DataProvider {
  readonly descriptor: ProviderDescriptor;
  search(query: SearchQuery): Promise<SearchPage>;
  getDataset(id: DatasetId): Promise<Dataset>;
  getResource(id: ResourceId): Promise<Resource>;
  listDatasetResources(id: DatasetId): Promise<readonly Resource[]>;
  resolveResource(resource: Resource): Promise<ResolvedResource>;
}
export interface DataFile {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mediaType?: string;
  readonly source?: CanonicalReference;
}
export type FieldType =
  "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "null" | "mixed";
export interface Field {
  readonly name: string;
  readonly type: FieldType;
  readonly nullable: boolean;
  readonly description?: string;
}
interface DataSchema {
  readonly fields: readonly Field[];
  readonly rowCount?: number;
}
type ValidationSeverity = "error" | "warning" | "recommendation";
export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly severity: ValidationSeverity;
  readonly row?: number;
  readonly field?: string;
  readonly context?: Readonly<Record<string, unknown>>;
}
export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
  readonly recommendations: readonly ValidationIssue[];
  readonly schema?: DataSchema;
}
interface TransformationRecord {
  readonly operation: string;
  readonly timestamp: string;
  readonly inputSha256?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}
export interface Provenance {
  readonly schemaVersion: "1";
  readonly providerId?: ProviderId;
  readonly datasetId?: DatasetId;
  readonly resourceId?: ResourceId;
  readonly sourceUrl?: string;
  readonly title?: string;
  readonly organization?: string;
  readonly retrievedAt: string;
  readonly sourceModifiedAt?: string;
  readonly sha256: string;
  readonly mediaType?: string;
  readonly localPath: string;
  readonly transformations: readonly TransformationRecord[];
}
export interface DownloadRecord {
  readonly file: DataFile;
  readonly source: CanonicalReference;
  readonly downloadedAt: string;
  readonly provenance: Provenance;
}
type DataRow = Readonly<Record<string, unknown>>;
export interface QueryResult {
  readonly sql: string;
  readonly columns: readonly string[];
  readonly rows: readonly DataRow[];
  readonly returnedCount: number;
  readonly totalCount?: number;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly source?: CanonicalReference;
  readonly provenance?: Provenance;
}
export type Configuration = Readonly<Record<string, unknown>>;

interface ParsedDatasetReference {
  readonly providerId: ProviderId;
  readonly kind: "dataset";
  readonly id: DatasetId;
}
interface ParsedResourceReference {
  readonly providerId: ProviderId;
  readonly kind: "resource";
  readonly id: ResourceId;
}
interface ParsedLocalFileReference {
  readonly providerId: "local";
  readonly kind: "file";
  readonly id: string;
}
export type ParsedCanonicalReference =
  ParsedDatasetReference | ParsedResourceReference | ParsedLocalFileReference;

type SupportedDataFormat = DataFormat;
export type SupportedInputFormat = SupportedDataFormat | "xml" | "pcaxis";
export type DetectedTextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1250";
type DelimitedDialect = "," | "\t" | ";" | "|";
export interface ArchiveLimits {
  readonly maxEntries: number;
  readonly maxPathBytes: number;
  readonly maxSelectedBytes: number;
  readonly maxExpandedBytes: number;
  readonly maxCompressionRatio: number;
}
export interface XmlLimits {
  readonly maxDocumentBytes: number;
  readonly maxDepth: number;
  readonly maxAttributesPerElement: number;
  readonly maxValueBytes: number;
  readonly maxColumns: number;
  readonly maxRecords: number;
  readonly maxStateBytes: number;
}
export interface PcAxisLimits {
  readonly maxSourceBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxMetadataStatements: number;
  readonly maxStatementBytes: number;
  readonly maxDimensions: number;
  readonly maxValuesPerDimension: number;
  readonly maxCells: number;
  readonly maxDecodedStringBytes: number;
  readonly maxNotes: number;
  readonly maxLanguageVariants: number;
  readonly maxCellTokenBytes: number;
  readonly maxEmittedRecords: number;
  readonly maxStagingBytes: number;
}
type DetectedInputFormat = SupportedInputFormat | "zip" | "unknown";
type DetectionConfidence =
  "signature" | "media-type" | "content" | "declared-format" | "extension" | "unknown";
interface DataSource {
  readonly path: string;
  readonly mediaType?: string;
  readonly declaredFormat?: string;
  readonly sha256?: string;
}
type DataInput = string | DataSource;
interface DataResolutionOptions {
  readonly allowInsecureHttp?: boolean;
  readonly allowPrivateNetwork?: boolean;
  readonly entry?: string;
  readonly recordPath?: string;
}
interface DataOperationOptions extends DataResolutionOptions {
  readonly limit?: number;
  readonly sheet?: string;
}
interface FormatDetection {
  readonly path: string;
  readonly format: DetectedInputFormat;
  readonly confidence: DetectionConfidence;
  readonly mediaType?: string;
  readonly extension?: string;
  readonly encoding?: DetectedTextEncoding;
}
interface DataInspection extends FormatDetection {
  readonly sizeBytes: number;
  readonly sheets?: readonly string[];
}
interface EngineValidationIssue {
  readonly code: string;
  readonly severity: ValidationSeverity;
  readonly message: string;
  readonly recommendation: string;
  readonly row?: number;
  readonly column?: number;
  readonly field?: string;
  readonly context?: Readonly<Record<string, unknown>>;
}
export interface DataPreview {
  readonly format: SupportedInputFormat;
  readonly columns: readonly string[];
  readonly codeColumns?: readonly string[];
  readonly rows: readonly DataRow[];
  readonly returnedCount: number;
  readonly truncated: boolean;
  readonly sheet?: string;
  readonly warnings: readonly EngineValidationIssue[];
  readonly encoding?: DetectedTextEncoding;
  readonly delimiter?: DelimitedDialect;
}
type InferredFieldType = "boolean" | "integer" | "double" | "date" | "timestamp" | "string";
interface InferredField {
  readonly name: string;
  readonly type: InferredFieldType;
  readonly nullable: boolean;
  readonly evidence: readonly unknown[];
}
interface InferredSchema {
  readonly fields: readonly InferredField[];
  readonly sampledRows: number;
  readonly format: SupportedInputFormat;
  readonly sheet?: string;
}
interface DataValidationResult {
  readonly valid: boolean;
  readonly format?: DetectedInputFormat;
  readonly issues: readonly EngineValidationIssue[];
  readonly errors: readonly EngineValidationIssue[];
  readonly warnings: readonly EngineValidationIssue[];
  readonly recommendations: readonly EngineValidationIssue[];
  readonly schema?: InferredSchema;
}
interface DataConversionOptions extends DataResolutionOptions {
  readonly output: string;
  readonly targetFormat: SupportedDataFormat;
  readonly sheet?: string;
  readonly force?: boolean;
  readonly spreadsheetSafe?: boolean;
}
interface EngineConversionResult {
  readonly input: string;
  readonly output: string;
  readonly targetFormat: DataFormat;
  readonly bytesWritten?: number;
  readonly provenance: Provenance;
  readonly provenancePath: string;
  readonly warnings: readonly EngineValidationIssue[];
}

interface DownloadLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects?: number;
  readonly headersTimeoutMs?: number;
  readonly bodyTimeoutMs?: number;
}
interface DownloadInput {
  readonly url: string;
  readonly destination: string;
  readonly limits: DownloadLimits;
  readonly allowInsecureHttp?: boolean;
  readonly allowPrivateNetwork?: boolean;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
}
interface DownloadResult {
  readonly path: string;
  readonly finalUrl: string;
  readonly redirectChain: readonly string[];
  readonly bytes: number;
  readonly mediaType?: string;
  readonly sha256: string;
}
interface ProbeResult {
  readonly finalUrl: string;
  readonly redirectChain: readonly string[];
  readonly status: number;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
}
interface ResourceDownloadOptions {
  readonly providerId?: string;
  readonly destination?: string;
  readonly force?: boolean;
  readonly allowInsecureHttp?: boolean;
  readonly allowPrivateNetwork?: boolean;
  readonly signal?: AbortSignal;
}
interface Downloader {
  probe(input: Omit<DownloadInput, "destination">): Promise<ProbeResult>;
  download(input: DownloadInput): Promise<DownloadResult>;
}
interface DownloadProvenanceInput {
  readonly sourceUrl: string;
  readonly finalUrl: string;
  readonly redirectChain: readonly string[];
  readonly retrievedAt: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType?: string;
  readonly overrideFlags: {
    readonly allowPrivateNetwork: boolean;
    readonly allowInsecureHttp: boolean;
  };
  readonly providerId?: string;
  readonly datasetId?: string;
  readonly resourceId?: string;
}
interface StoredDownloadProvenance extends DownloadProvenanceInput {
  readonly schemaVersion: "1";
  readonly localPath: string;
}
interface StoredDerivedProvenance {
  readonly schemaVersion: "1";
  readonly retrievedAt: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType?: string;
  readonly localPath: string;
  readonly transformations: readonly TransformationRecord[];
}
interface ProvenanceStore {
  pathFor(artifact: string): string;
  write(artifact: string, input: DownloadProvenanceInput): Promise<string>;
  read(artifact: string): Promise<StoredDownloadProvenance | StoredDerivedProvenance>;
  verify(
    artifact: string,
  ): Promise<{ readonly valid: true; readonly sha256: string; readonly bytes: number }>;
}
interface CacheObject {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}
interface CacheLayout {
  readonly root: string;
  readonly objects: string;
  readonly metadata: string;
  readonly locks: string;
  ensure(): Promise<this>;
  objectPath(sha256: string): string;
  metadataPath(key: string): string;
}
type ReadableLike = AsyncIterable<Uint8Array | string>;
interface ContentCache {
  layout(): Promise<CacheLayout>;
  putObject(input: ReadableLike | AsyncIterable<Uint8Array | string>): Promise<CacheObject>;
  getObject(sha256: string): Promise<CacheObject>;
  materialize(
    sha256: string,
    requestedDestination: string,
    force?: boolean,
    maxBytes?: number,
  ): Promise<CacheObject>;
  putObjectWithMetadata<T>(
    key: string,
    schemaVersion: string,
    input: ReadableLike | AsyncIterable<Uint8Array | string>,
    value: T,
    ttlMs?: number,
  ): Promise<CacheObject>;
  putMetadata<T>(
    key: string,
    schemaVersion: string,
    value: T,
    objectSha256?: string,
    ttlMs?: number,
  ): Promise<void>;
  getMetadata<T>(
    key: string,
    schemaVersion: string,
    includeExpired?: boolean,
  ): Promise<T | undefined>;
  get<T>(key: string, schemaVersion: string): Promise<T | undefined>;
  set<T>(key: string, schemaVersion: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  verify(): Promise<{
    readonly objects: number;
    readonly metadata: number;
    readonly errors: readonly string[];
  }>;
  list(): Promise<readonly { readonly file: string; readonly bytes: number }[]>;
  info(): Promise<{
    readonly root: string;
    readonly objects: number;
    readonly metadata: number;
    readonly bytes: number;
  }>;
  prune(): Promise<{ readonly removed: number }>;
  clear(): Promise<void>;
}
interface DownloadServiceOptions {
  readonly registry: ProviderRegistry;
  readonly providerId: string;
  readonly downloader?: Downloader;
  readonly provenance?: ProvenanceStore;
  readonly cache?: ContentCache;
  readonly offline?: boolean;
  readonly downloadDir: string;
  readonly limits: DownloadLimits;
}

declare class DatasetCatalog {
  get(id: DatasetId, selectedProviderId?: string): Promise<Dataset>;
  resources(id: DatasetId): Promise<readonly Resource[]>;
}
declare class ResourceCatalog {
  get(id: ResourceId, selectedProviderId?: string): Promise<Resource>;
}
declare class ProviderCatalog {
  list(): readonly ProviderDescriptor[];
}
declare class DownloadService {
  resource(
    id: ResourceId,
    options?: ResourceDownloadOptions,
  ): Promise<DownloadResult & { readonly provenancePath: string }>;
  headers(
    id: ResourceId,
    options?: Omit<ResourceDownloadOptions, "destination" | "force">,
  ): Promise<ProbeResult>;
}
declare class CacheService {
  info(): Promise<{
    readonly root: string;
    readonly objects: number;
    readonly metadata: number;
    readonly bytes: number;
    readonly derived: {
      readonly objects: number;
      readonly bytes: number;
      readonly maxBytes: number;
      readonly ttlMs: number;
    };
  }>;
  list(): Promise<
    readonly {
      readonly file: string;
      readonly bytes: number;
      readonly kind: "raw" | "duckdb-stage";
      readonly key?: string;
      readonly format?: Exclude<SupportedInputFormat, "xml">;
      readonly sheet?: string;
      readonly createdAt?: string;
      readonly lastUsedAt?: string;
      readonly expiresAt?: string;
    }[]
  >;
  clear(): ReturnType<ContentCache["clear"]>;
  prune(): Promise<{
    readonly removed: number;
    readonly derivedExpiredRemoved: number;
    readonly derivedLruRemoved: number;
    readonly derivedObjectsRemoved: number;
  }>;
  verify(): ReturnType<ContentCache["verify"]>;
}
declare class DataService {
  withResolvedInput<T>(
    input: string,
    options: DataResolutionOptions,
    operation: (source: DataInput) => Promise<T>,
  ): Promise<T>;
  inspect(input: string, options?: DataResolutionOptions): Promise<DataInspection>;
  preview(input: string, options?: DataOperationOptions): Promise<DataPreview>;
  inferSchema(input: string, options?: DataOperationOptions): Promise<InferredSchema>;
  validate(input: string, options?: DataOperationOptions): Promise<DataValidationResult>;
  convert(input: string, options: DataConversionOptions): Promise<EngineConversionResult>;
}
interface ConversionServiceOptions extends DataResolutionOptions {
  readonly output: string;
  readonly targetFormat: SupportedDataFormat;
  readonly sheet?: string;
  readonly force?: boolean;
  readonly spreadsheetSafe?: boolean;
}
declare class ConversionService {
  convert(input: string, options: ConversionServiceOptions): Promise<EngineConversionResult>;
}
interface QueryServiceOptions extends DataResolutionOptions {
  readonly sql: string;
  readonly limit?: number;
  readonly timeoutMs?: number;
  readonly memoryLimit?: string;
  readonly threads?: number;
  readonly sheet?: string;
  readonly output?: string;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}
interface QueryServiceResult {
  readonly columns: readonly string[];
  readonly rows: readonly DataRow[];
  readonly returnedCount: number;
  readonly truncated: boolean;
  readonly sql: string;
  readonly source: string;
  readonly durationMs: number;
  readonly cache: QueryCacheMetadata;
  readonly warnings: readonly QueryDatabaseWarning[];
  readonly output?: string;
  readonly provenancePath?: string;
}
export type QueryCacheStatus = "hit" | "miss" | "bypass";
export interface QueryCacheMetadata {
  readonly status: QueryCacheStatus;
  readonly kind: "duckdb-stage";
}
export interface QueryCacheWarning {
  readonly code: "QUERY_CACHE_BYPASS";
  readonly message: string;
}
export type QueryDatabaseWarning = QueryCacheWarning | EngineValidationIssue;
export interface DuckDbCachePolicy {
  readonly enabled: boolean;
  readonly maxBytes: number;
  readonly ttlMs: number;
}
export interface ColumnProfile {
  readonly column: string;
  readonly type: string;
  readonly count: number;
  readonly nullCount: number;
  readonly nullPercent: number | null;
  readonly distinctApprox: number;
  readonly min: string | null;
  readonly max: string | null;
  readonly mean: number | null;
  readonly stddev: number | null;
}
export interface ProfileServiceOptions extends DataResolutionOptions {
  readonly timeoutMs?: number;
  readonly memoryLimit?: string;
  readonly threads?: number;
  readonly sheet?: string;
  readonly recordPath?: string;
  readonly signal?: AbortSignal;
}
export interface ProfileServiceResult {
  readonly columns: readonly ColumnProfile[];
  readonly source: string;
  readonly columnCount: number;
  readonly rowCount: number;
  readonly durationMs: number;
  readonly cache: QueryCacheMetadata;
  readonly warnings: readonly QueryDatabaseWarning[];
}
declare class QueryService {
  execute(input: string, options: QueryServiceOptions): Promise<QueryServiceResult>;
  profile(input: string, options: ProfileServiceOptions): Promise<ProfileServiceResult>;
}

export type WfsVersion = "2.0.0" | "1.1.0" | "1.0.0";
export interface WfsLayer {
  readonly name: string;
  readonly title?: string;
  readonly defaultCrs?: string;
  readonly otherCrs: readonly string[];
}
export interface WfsCapabilities {
  readonly version: WfsVersion;
  readonly operations: readonly string[];
  readonly layers: readonly WfsLayer[];
  readonly outputFormats: readonly string[];
}
export interface WfsField {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
}
export interface WfsQuery {
  readonly version: WfsVersion;
  readonly request: "GetCapabilities" | "DescribeFeatureType" | "GetFeature";
  readonly layer?: string;
  readonly limit?: number;
  readonly startIndex?: number;
  readonly properties?: readonly string[];
  readonly outputFormat?: string;
  readonly resultType?: "hits" | "results";
}
export interface WfsNetworkOptions {
  readonly allowInsecureHttp?: boolean;
  readonly allowPrivateNetwork?: boolean;
  readonly signal?: AbortSignal;
}
export interface WfsSelectionOptions extends WfsNetworkOptions {
  readonly layer: string;
  readonly properties?: readonly string[];
  readonly filters?: Readonly<Record<string, string | number | boolean>>;
  readonly bbox?: readonly [number, number, number, number];
  readonly crs?: string;
  readonly limit?: number;
  readonly startIndex?: number;
}
export interface WfsPreviewResult {
  readonly version: WfsVersion;
  readonly layer: string;
  readonly columns: readonly string[];
  readonly rows: readonly DataRow[];
  readonly returnedCount: number;
  readonly truncated: boolean;
}
declare class WfsService {
  inspect(
    input: string,
    network?: WfsNetworkOptions,
  ): Promise<{ readonly resource: string; readonly capabilities: WfsCapabilities }>;
  layers(input: string, network?: WfsNetworkOptions): Promise<readonly WfsLayer[]>;
  schema(
    input: string,
    options: WfsNetworkOptions & { readonly layer: string },
  ): Promise<readonly WfsField[]>;
  preview(input: string, options: WfsSelectionOptions): Promise<WfsPreviewResult>;
  count(
    input: string,
    options: Omit<WfsSelectionOptions, "limit" | "startIndex" | "properties">,
  ): Promise<{ readonly version: WfsVersion; readonly layer: string; readonly count: number }>;
  export(
    input: string,
    options: WfsSelectionOptions & {
      readonly output: string;
      readonly force?: boolean;
      readonly format?: "csv";
    },
  ): Promise<{ readonly output: string; readonly provenancePath: string; readonly rows: number }>;
}
declare class ResourceAccessService {
  inspect(input: string, options?: DataResolutionOptions): Promise<ResourceAccessDescriptor>;
}

export class ProviderRegistry {
  constructor(providers?: readonly DataProvider[]);
  register(provider: DataProvider): void;
  get(id: ProviderId | string): DataProvider;
  list(): readonly ProviderDescriptor[];
}
export interface KlopsiClientOptions {
  readonly registry: ProviderRegistry;
  readonly providerId: string;
  readonly downloads?: Omit<DownloadServiceOptions, "registry" | "providerId">;
  readonly cache?: ContentCache;
  readonly duckdbCache?: DuckDbCachePolicy;
  readonly cwd?: string;
  readonly queryWorkerPath?: string | URL;
  readonly archiveLimits?: ArchiveLimits;
  readonly xmlLimits?: XmlLimits;
  readonly pcAxisLimits?: PcAxisLimits;
}
export class KlopsiClient {
  constructor(options: KlopsiClientOptions);
  readonly datasets: DatasetCatalog;
  readonly resources: ResourceCatalog;
  readonly providers: ProviderCatalog;
  readonly downloads?: DownloadService;
  readonly cache?: CacheService;
  readonly data: DataService;
  readonly conversions: ConversionService;
  readonly query: QueryService;
  readonly services: { readonly wfs: WfsService };
  readonly access: ResourceAccessService;
  search(query: SearchQuery): Promise<SearchPage>;
}
