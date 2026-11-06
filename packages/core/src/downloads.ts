import { basename, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, rm, stat } from "node:fs/promises";
import { EXIT_CODES, KlopsiError, type ResourceId } from "@klopsi/domain";
import {
  Downloader,
  ProvenanceStore,
  filenameFromUrl,
  safeFilename,
  redactUrl,
  publishArtifactPair,
  type CacheObject,
  type ContentCache,
  type DownloadLimits,
  type DownloadResult,
  type ProbeResult,
} from "@klopsi/storage";
import type { ProviderRegistry } from "./registry.js";

export interface ResourceDownloadOptions {
  readonly providerId?: string;
  readonly destination?: string;
  readonly force?: boolean;
  readonly allowInsecureHttp?: boolean;
  readonly allowPrivateNetwork?: boolean;
  readonly signal?: AbortSignal;
  readonly requireTabular?: boolean;
  readonly requireData?: boolean;
}
export interface DownloadServiceOptions {
  readonly registry: ProviderRegistry;
  readonly providerId: string;
  readonly downloader?: Downloader;
  readonly provenance?: ProvenanceStore;
  readonly cache?: ContentCache;
  readonly offline?: boolean;
  readonly downloadDir: string;
  readonly limits: DownloadLimits;
}
interface CachedDownload {
  readonly sha256: string;
  readonly bytes: number;
  readonly finalUrl: string;
  readonly redirectChain: readonly string[];
  readonly mediaType?: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly retrievalSource?: string;
}

async function destinationPath(requested: string | undefined, fallback: string): Promise<string> {
  if (requested === undefined) return fallback;
  try {
    return (await stat(requested)).isDirectory() ? join(requested, basename(fallback)) : requested;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return requested;
    throw error;
  }
}
function downloadTooLarge(): KlopsiError {
  return new KlopsiError({
    code: "DOWNLOAD_TOO_LARGE",
    message: "The download exceeds the byte limit.",
    exitCode: EXIT_CODES.INVALID_INPUT,
  });
}
function cacheCorrupt(message: string, cause?: unknown): KlopsiError {
  return new KlopsiError({
    code: "CACHE_CORRUPT",
    message,
    exitCode: EXIT_CODES.INTEGRITY_FAILURE,
    ...(cause === undefined ? {} : { cause }),
  });
}
async function validateMaterializedCacheObject(
  path: string,
  expected: CacheObject,
  maxBytes: number,
): Promise<void> {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    throw cacheCorrupt("The materialized cache object is missing.", error);
  }
  if (!details.isFile() || details.isSymbolicLink())
    throw cacheCorrupt("The materialized cache object is not a regular file.");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const raw of createReadStream(path)) {
      const chunk = Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > maxBytes) throw downloadTooLarge();
      hash.update(chunk);
    }
  } catch (error) {
    if (error instanceof KlopsiError) throw error;
    throw cacheCorrupt("The materialized cache object could not be read.", error);
  }
  if (bytes !== details.size || bytes !== expected.bytes || hash.digest("hex") !== expected.sha256)
    throw cacheCorrupt("The materialized cache object failed integrity verification.");
}
async function materializeCachedObject(
  cache: ContentCache,
  sha256: string,
  destination: string,
  maxBytes: number,
): Promise<CacheObject> {
  const expected = await cache.getObject(sha256);
  if (expected.sha256 !== sha256)
    throw cacheCorrupt("The cached object digest does not match the requested object.");
  if (expected.bytes > maxBytes) throw downloadTooLarge();
  try {
    await cache.materialize(sha256, destination, false, maxBytes);
    await validateMaterializedCacheObject(destination, expected, maxBytes);
    return { ...expected, path: destination };
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
}
export class DownloadService {
  private readonly downloader: Downloader;
  private readonly provenance: ProvenanceStore;
  constructor(private readonly options: DownloadServiceOptions) {
    this.downloader = options.downloader ?? new Downloader();
    this.provenance = options.provenance ?? new ProvenanceStore();
  }
  async resource(
    id: ResourceId,
    options: ResourceDownloadOptions = {},
  ): Promise<DownloadResult & { readonly provenancePath: string }> {
    const selectedProviderId = options.providerId ?? this.options.providerId;
    const provider = this.options.registry.get(selectedProviderId);
    const resource = await provider.getResource(id);
    const resolved = await provider.resolveResource(resource);
    if (
      (options.requireTabular === true && resolved.kind !== "file") ||
      (options.requireData === true && resolved.kind !== "file" && resolved.kind !== "archive")
    )
      throw new KlopsiError({
        code: resolved.kind === "archive" ? "DOWNLOAD_ONLY_FORMAT" : "UNSUPPORTED_RESOURCE_KIND",
        message:
          resolved.kind === "archive"
            ? "Archives are download-only and cannot be used directly as tabular input."
            : `The ${resolved.kind} resource is not a direct tabular file.`,
        exitCode: EXIT_CODES.UNSUPPORTED,
        suggestion:
          resolved.kind === "archive"
            ? "Download and extract a supported CSV, TSV, JSON, NDJSON, XLSX, or Parquet file."
            : "Open the resource endpoint or choose a direct tabular file resource.",
        context: { kind: resolved.kind, resourceId: `${resource.id}` },
      });
    const fallback = join(
      this.options.downloadDir,
      safeFilename(resolved.filename, filenameFromUrl(resolved.url, safeFilename(`${id}`))),
    );
    const destination = await destinationPath(options.destination, fallback);
    const token = `${process.pid}-${randomUUID()}`;
    const stagedDestination = `${destination}.part-${token}`;
    const stagedProvenance = `${destination}.provenance.json.part-${token}`;
    const cacheKey = `download:${resource.providerId}:${resource.id}`;
    let result: DownloadResult;
    if (this.options.offline) {
      const cached = await this.options.cache?.getMetadata<CachedDownload>(cacheKey, "download-v1");
      if (cached === undefined || this.options.cache === undefined)
        throw new KlopsiError({
          code: "OFFLINE_CACHE_MISS",
          message: "Offline mode has no cached content for this resource.",
          exitCode: EXIT_CODES.NOT_FOUND,
          context: { resourceId: id },
        });
      const materialized = await materializeCachedObject(
        this.options.cache,
        cached.sha256,
        stagedDestination,
        this.options.limits.maxBytes,
      );
      result = {
        path: materialized.path,
        sha256: materialized.sha256,
        bytes: materialized.bytes,
        finalUrl: cached.finalUrl,
        redirectChain: cached.redirectChain,
        ...(cached.mediaType === undefined ? {} : { mediaType: cached.mediaType }),
      };
    } else {
      const cachedRecord = await this.options.cache?.getMetadataRecord<CachedDownload>(
        cacheKey,
        "download-v1",
        true,
      );
      const conditionalHeaders = {
        ...(cachedRecord?.etag === undefined ? {} : { "if-none-match": cachedRecord.etag }),
        ...(cachedRecord?.lastModified === undefined
          ? {}
          : { "if-modified-since": cachedRecord.lastModified }),
      };
      const commonRequest = {
        url: resolved.url,
        limits: this.options.limits,
        ...(options.allowInsecureHttp === undefined
          ? {}
          : { allowInsecureHttp: options.allowInsecureHttp }),
        ...(options.allowPrivateNetwork === undefined
          ? {}
          : { allowPrivateNetwork: options.allowPrivateNetwork }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
      const conditional =
        cachedRecord === undefined || Object.keys(conditionalHeaders).length === 0
          ? undefined
          : // The GET below has its own retry budget; the revalidation probe does not stack one.
            await this.downloader.probe({
              ...commonRequest,
              limits: { ...this.options.limits, retries: 0 },
              headers: conditionalHeaders,
            });
      if (
        conditional?.status === 304 &&
        this.options.cache !== undefined &&
        cachedRecord !== undefined
      ) {
        const materialized = await materializeCachedObject(
          this.options.cache,
          cachedRecord.value.sha256,
          stagedDestination,
          this.options.limits.maxBytes,
        );
        result = {
          path: materialized.path,
          sha256: materialized.sha256,
          bytes: materialized.bytes,
          finalUrl: cachedRecord.value.finalUrl,
          redirectChain: cachedRecord.value.redirectChain,
          ...(cachedRecord.value.mediaType === undefined
            ? {}
            : { mediaType: cachedRecord.value.mediaType }),
          ...(cachedRecord.etag === undefined ? {} : { etag: cachedRecord.etag }),
          ...(cachedRecord.lastModified === undefined
            ? {}
            : { lastModified: cachedRecord.lastModified }),
        };
      } else {
        result = await this.downloader.download({
          ...commonRequest,
          destination: stagedDestination,
          force: false,
        });
      }
    }
    let dataset;
    try {
      dataset = await provider.getDataset(resource.datasetId);
    } catch {
      dataset = undefined;
    }
    let publication;
    try {
      await this.provenance.write(
        result.path,
        {
          sourceUrl: resolved.url,
          finalUrl: result.finalUrl,
          redirectChain: result.redirectChain,
          retrievedAt: new Date().toISOString(),
          sha256: result.sha256,
          bytes: result.bytes,
          ...(result.mediaType === undefined ? {} : { mediaType: result.mediaType }),
          overrideFlags: {
            allowPrivateNetwork: options.allowPrivateNetwork ?? false,
            allowInsecureHttp: options.allowInsecureHttp ?? false,
          },
          providerId: `${resource.providerId}`,
          datasetId: `${resource.datasetId}`,
          resourceId: `${resource.id}`,
          title: resource.title,
          ...(dataset?.organization?.title === undefined
            ? {}
            : { organization: dataset.organization.title }),
          ...(resource.modifiedAt === undefined ? {} : { sourceModifiedAt: resource.modifiedAt }),
          transformations: [],
        },
        { publishedArtifact: destination, sidecarPath: stagedProvenance },
      );
      publication = await publishArtifactPair(result.path, stagedProvenance, destination, {
        force: options.force ?? false,
        existsCode: "DOWNLOAD_DESTINATION_EXISTS",
        existsExitCode: EXIT_CODES.INVALID_INPUT,
      });
    } catch (error) {
      await Promise.all([
        rm(stagedDestination, { force: true }),
        rm(stagedProvenance, { force: true }),
      ]);
      throw error;
    }
    if (!this.options.offline && this.options.cache !== undefined) {
      const object = await this.options.cache.putObjectWithMetadata(
        cacheKey,
        "download-v1",
        createReadStream(publication.output),
        (stored): CachedDownload => ({
          sha256: stored.sha256,
          bytes: stored.bytes,
          finalUrl: redactUrl(result.finalUrl),
          redirectChain: result.redirectChain.map(redactUrl),
          ...(result.mediaType === undefined ? {} : { mediaType: result.mediaType }),
          ...(result.etag === undefined ? {} : { etag: result.etag }),
          ...(result.lastModified === undefined ? {} : { lastModified: result.lastModified }),
          retrievalSource: redactUrl(resolved.url),
        }),
        undefined,
        {
          ...(result.etag === undefined ? {} : { etag: result.etag }),
          ...(result.lastModified === undefined ? {} : { lastModified: result.lastModified }),
          source: redactUrl(resolved.url),
        },
      );
      if (object.sha256 !== result.sha256)
        throw new KlopsiError({
          code: "CACHE_CORRUPT",
          message: "Cached download digest mismatch.",
          exitCode: EXIT_CODES.INTEGRITY_FAILURE,
        });
    }
    return { ...result, path: publication.output, provenancePath: publication.provenancePath };
  }
  async headers(
    id: ResourceId,
    options: Omit<ResourceDownloadOptions, "destination" | "force"> = {},
  ): Promise<ProbeResult> {
    if (this.options.offline)
      throw new KlopsiError({
        code: "OFFLINE_CACHE_MISS",
        message: "Resource headers are unavailable in offline mode.",
        exitCode: EXIT_CODES.NOT_FOUND,
      });
    const provider = this.options.registry.get(options.providerId ?? this.options.providerId);
    const resolved = await provider.resolveResource(await provider.getResource(id));
    return this.downloader.probe({
      url: resolved.url,
      limits: this.options.limits,
      ...(options.allowInsecureHttp === undefined
        ? {}
        : { allowInsecureHttp: options.allowInsecureHttp }),
      ...(options.allowPrivateNetwork === undefined
        ? {}
        : { allowPrivateNetwork: options.allowPrivateNetwork }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
}
