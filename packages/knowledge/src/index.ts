/**
 * @periscope/knowledge — layer 5 of the Periscope architecture.
 *
 * SQLite is the system of record. Qdrant is a rebuildable semantic index.
 * Artifacts are content-addressed files on disk. Nothing here talks to Steel,
 * Stagehand, or Claude.
 */

export {
  Storage,
  StorageError,
  AssociationError,
  MigrationError,
  ValidationError,
  JOB_KINDS,
} from "./storage.js";
export type {
  ArtifactRecord,
  BenchmarkFilter,
  BenchmarkRecord,
  CreateBenchmarkInput,
  CreateFindingInput,
  CreateJobInput,
  CreateRunInput,
  FindingRecord,
  FindingStatus,
  JobKind,
  JobRecord,
  LeasePurpose,
  ObservationFilter,
  PendingEmbedding,
  RecordArtifactInput,
  RunIdempotencyRecord,
  RunRecord,
  StorageOptions,
  StoredEvent,
  WriteContext,
  WriteOutcome,
} from "./storage.js";

export { MIGRATIONS, LATEST_VERSION } from "./migrations.js";
export type { Migration } from "./migrations.js";

export {
  MICRO_PER_USD,
  MoneyError,
  microToDecimalString,
  microToUsd,
  usdToMicro,
} from "./money.js";

export { isIsoUtc, nowIso, toIso } from "./time.js";

export {
  assertEvent,
  assertObservation,
  assertVantage,
  parseEventPayload,
  parseObservationPayload,
  parseStringArray,
} from "./json.js";

export {
  ArtifactCorruptedError,
  ArtifactError,
  ArtifactMissingError,
  ArtifactStore,
  artifactIdFor,
  artifactRelativePath,
  hashBytes,
  hashFile,
} from "./artifacts.js";
export type { ArtifactMeta, ArtifactRef, ArtifactStoreOptions } from "./artifacts.js";

export {
  Corpus,
  DEFAULT_CORPUS_CONFIG,
  corpusConfigFromEnv,
  embeddingTextFor,
  observationIdToPointId,
  payloadFor,
} from "./corpus.js";
export type {
  CorpusConfig,
  CorpusDeps,
  CorpusFilter,
  CorpusPayload,
  CorpusPoint,
  Embedder,
  HydratedHit,
  IndexOutcome,
  SearchHit,
  VectorStore,
} from "./corpus.js";

export { MiniLmEmbedder, l2Norm } from "./embedder.js";
export type { MiniLmOptions } from "./embedder.js";

export { QdrantVectorStore, buildQdrantFilter } from "./qdrant.js";
export type { QdrantStoreOptions } from "./qdrant.js";
