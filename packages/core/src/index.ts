export { DatasetCatalog, ProviderCatalog, ResourceCatalog } from "./catalog.js";
export { KlopsiClient } from "./client.js";
export type { KlopsiClientOptions } from "./client.js";
export { ProviderRegistry } from "./registry.js";
export { DownloadService } from "./downloads.js";
export type { DownloadServiceOptions, ResourceDownloadOptions } from "./downloads.js";
export { CacheService } from "./cache.js";
export { DataService } from "./data.js";
export type { DataConversionOptions, DataOperationOptions, DataResolutionOptions } from "./data.js";
export { ConversionService } from "./conversions.js";
export type { ConversionServiceOptions } from "./conversions.js";
export { QueryService } from "./queries.js";
export type {
  ProfileServiceOptions,
  ProfileServiceResult,
  QueryDatabaseServiceOptions,
  QueryDatabaseServiceResult,
  QueryServiceOptions,
  QueryServiceResult,
} from "./queries.js";
export { QueryDatabaseCache } from "./query-database-cache.js";
export type {
  QueryCacheMetadata,
  QueryCacheStatus,
  QueryCacheWarning,
  QueryDatabaseCacheOptions,
  QueryDatabaseExecutionOptions,
  QueryDatabaseLeaseResult,
  QueryDatabaseMetadata,
  QueryDatabasePreparationOptions,
  QueryDatabaseProfileOptions,
  QueryDatabaseProfileResult,
  QueryDatabaseResult,
  QueryDatabaseWarning,
} from "./query-database-cache.js";
export { validateDatasetMetadata, validateResourceMetadata } from "./metadata-validation.js";
export {
  WfsService,
  type WfsNetworkOptions,
  type WfsSelectionOptions,
  type WfsPreviewResult,
} from "./wfs/service.js";
export {
  buildWfsUrl,
  parseWfsCapabilities,
  parseWfsCount,
  parseWfsException,
  parseWfsSchema,
} from "./wfs/index.js";
export type {
  WfsCapabilities,
  WfsField,
  WfsLayer,
  WfsQuery,
  WfsRequest,
  WfsVersion,
} from "./wfs/index.js";
export { ResourceAccessService } from "./access.js";
export type { ArchiveLimits, PcAxisLimits, XmlLimits } from "@klopsi/data-engine";
