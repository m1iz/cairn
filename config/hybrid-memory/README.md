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

## Evaluation gate

The fixed bilingual dataset is
`packages/core/src/memory/fixtures/hybrid-memory-eval-v2.json`. The live
integration evaluation requires `CAIRN_MEMORY_INTEGRATION=1`,
`CAIRN_MEMORY_DATABASE_URL`, and optional report/receipt output paths. The
receipt is bound to both the dataset hash and embedding provider ID; Cairn will
not mutate model prompts in `on` mode without a matching passing receipt.

Local database files, downloaded model weights, passwords, reports, and
receipts belong outside the repository and must not be committed.
