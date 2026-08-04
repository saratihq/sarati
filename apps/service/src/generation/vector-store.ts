import { Injectable, Logger } from '@nestjs/common';

import { errorMessage } from '../common/error-message';
import { mergeComposioCatalog, sdkCatalogEntries } from '../providers/sdk-actions.registry';

/**
 * In-process node/module catalog retrieval: brute-force cosine over in-memory vectors, behind an
 * {@link EmbeddingProvider} seam (pgvector-swappable, ADR 0037). Feeds an LLM reranker.
 */

/** Catalog collections — the single built-in collection (ADR 0026), assembled in-process. */
export const ENGINE_COLLECTIONS = {
  orchestr: 'orchestr_actions',
} as const;

type CatalogEntry = Record<string, unknown>;

export interface EmbeddingProvider {
  embed(text: string): Float32Array;
}

const EMBED_DIM = 1024;

/** Multiplicative demotion for `source:'composio'` rows so a comparably relevant SDK row wins. */
const COMPOSIO_RANK_PENALTY = 0.6;

/** Deterministic hashing bag-of-words → L2-normalized vector. No deps, no key. */
export class HashingEmbedder implements EmbeddingProvider {
  embed(text: string): Float32Array {
    const vec = new Float32Array(EMBED_DIM);
    for (const token of tokenize(text)) {
      const idx = fnv1a(token) % EMBED_DIM;
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < EMBED_DIM; i += 1) vec[i] = (vec[i] ?? 0) / norm;
    }
    return vec;
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singularize);
}

/** Minimal S-stemmer (Harman) — must be applied to entries and queries symmetrically. */
function singularize(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith('ies') && !token.endsWith('eies') && !token.endsWith('aies')) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith('es') && !token.endsWith('aes') && !token.endsWith('ees') && !token.endsWith('oes')) {
    return token.slice(0, -1);
  }
  if (token.endsWith('s') && !token.endsWith('us') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Reweight a vector by per-bucket IDF and re-L2-normalize. */
function applyIdf(vec: Float32Array, idf: Float32Array): Float32Array {
  const out = new Float32Array(vec.length);
  let norm = 0;
  for (let i = 0; i < vec.length; i += 1) {
    const w = (vec[i] ?? 0) * (idf[i] ?? 1);
    out[i] = w;
    norm += w * w;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < out.length; i += 1) out[i] = (out[i] ?? 0) / norm;
  }
  return out;
}

/** Dot product of two L2-normalized vectors == cosine similarity. */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/** Build the searchable text for a catalog entry (name/category/description/use-cases/id). */
function entryText(entry: CatalogEntry): string {
  const parts: string[] = [];
  for (const key of ['name', 'category', 'description', 'type', 'module']) {
    const v = entry[key];
    if (typeof v === 'string') parts.push(v);
  }
  const useCases = entry.use_cases;
  if (Array.isArray(useCases)) parts.push(useCases.filter((u) => typeof u === 'string').join('. '));
  else if (typeof useCases === 'string') parts.push(useCases);
  return parts.join(' ');
}

interface Collection {
  entries: CatalogEntry[];
  vectors: Float32Array[];
  /** Per-bucket IDF weights — query vectors get the same weighting at search time. */
  idf: Float32Array;
}

@Injectable()
export class VectorStore {
  private readonly logger = new Logger(VectorStore.name);
  // Field-initialized, not injected: `EmbeddingProvider` is a TS interface with no DI token.
  private readonly embedder: EmbeddingProvider = new HashingEmbedder();
  private readonly collections = new Map<string, Collection>();
  private readonly defaultCollection = ENGINE_COLLECTIONS.orchestr;

  /** The raw catalog entries for a collection — read-only. */
  entries(collection?: string): readonly CatalogEntry[] {
    return this.collection(collection ?? this.defaultCollection).entries;
  }

  search(query: string, topK = 8, collection?: string): CatalogEntry[] {
    const col = this.collection(collection ?? this.defaultCollection);
    const queryVec = applyIdf(this.embedder.embed(query), col.idf);
    const scored = col.entries.map((entry, i) => {
      const raw = cosine(queryVec, col.vectors[i] ?? new Float32Array(EMBED_DIM));
      // Demote universal-fallback (Composio) rows below first-class SDK rows.
      const sim = entry.source === 'composio' ? raw * COMPOSIO_RANK_PENALTY : raw;
      return { entry, sim };
    });
    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, topK).map(({ entry, sim }) => ({
      ...entry,
      similarity_score: Math.round(Math.min(1, sim) * 1000) / 10,
    }));
  }

  private collection(name: string): Collection {
    let col = this.collections.get(name);
    if (!col) {
      col = this.load(name);
      this.collections.set(name, col);
    }
    return col;
  }

  private load(name: string): Collection {
    // An unknown collection degrades to empty rather than throwing — rerank over [] → [].
    if (name !== ENGINE_COLLECTIONS.orchestr) {
      this.logger.warn(`Unknown catalog "${name}" — retrieval will return no candidates.`);
      return { entries: [], vectors: [], idf: new Float32Array(EMBED_DIM).fill(1) };
    }
    try {
      return this.vectorize(mergeComposioCatalog(sdkCatalogEntries()));
    } catch (err) {
      this.logger.warn(`Failed to assemble the built-in catalog: ${errorMessage(err)}`);
      return { entries: [], vectors: [], idf: new Float32Array(EMBED_DIM).fill(1) };
    }
  }

  /** Embed a catalog's entries into an IDF-weighted collection. */
  private vectorize(entries: CatalogEntry[]): Collection {
    // IDF over hash buckets so catalog-common tokens ("get", "create") don't drown out rare ones.
    const rawVectors = entries.map((e) => this.embedder.embed(entryText(e)));
    const df = new Float32Array(EMBED_DIM);
    for (const v of rawVectors) {
      for (let i = 0; i < EMBED_DIM; i += 1) if (v[i]) df[i] = (df[i] ?? 0) + 1;
    }
    const idf = new Float32Array(EMBED_DIM);
    for (let i = 0; i < EMBED_DIM; i += 1) {
      idf[i] = Math.log((entries.length + 1) / ((df[i] ?? 0) + 1)) + 1;
    }
    const vectors = rawVectors.map((v) => applyIdf(v, idf));
    return { entries, vectors, idf };
  }
}
