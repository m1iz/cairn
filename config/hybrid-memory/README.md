# Optional local hybrid-memory services

Cairn keeps Markdown as the authoritative memory source. This stack is only a
derived embedding cache and retrieval index. Hybrid memory remains `off` unless
a trusted local config explicitly enables it, and runtime failures fall back to
in-memory vectors or keyword retrieval.

## Local services

1. Copy `.env.example` to `.env`, choose a local password, and keep `.env`
   untracked.
2. Set `CAIRN_MEMORY_DATA_DIR` to a directory outside the repository (for
   example `D:/CairnData/memory-services`).
3. Run `docker compose --env-file .env up -d` in this directory.

The stack binds only to loopback:

- TEI at `http://127.0.0.1:8088`, serving
  `intfloat/multilingual-e5-small` (384 dimensions).
- PostgreSQL + pgvector at `127.0.0.1:54329`.

## Activation

Hybrid memory activation is controlled by trusted local configuration and a
provider-bound capability receipt. Without a matching receipt, Cairn does not
project derived memory into model prompts. Local database files, downloaded
model weights, passwords, and runtime state belong outside the repository.

The optional local cross-encoder is started with
`docker compose --profile reranker up -d`. It uses the NVIDIA GPU and stores
the downloaded `BAAI/bge-reranker-v2-m3` weights under
`CAIRN_MEMORY_DATA_DIR`; retrieval remains available through RRF when this
service is stopped or times out.

Trusted local configuration can enable it independently from the embedding
provider:

```json
{
  "memory": {
    "reranker": {
      "provider": "tei",
      "endpoint": "http://127.0.0.1:8089",
      "model": "BAAI/bge-reranker-v2-m3",
      "timeoutMs": 800
    }
  }
}
```

The production path uses reciprocal-rank fusion, reranks at most twenty
candidates, and applies an admission decision before any memory is projected
into the model prompt. A weak top result therefore produces an explicit empty
memory result instead of injecting the nearest unrelated chunk.
