# Stem GTE Memory: download and use

Stem downloads the selected GTE epoch2 model on demand. Since 0.5.2 it is the default for a fresh install and the recall recommendation (`src/shared/recall-recommended.ts`): the release popup offers the switch to installs whose stored reranker settings predate it. Selecting GTE uses it for both memory facts and skill selection. Desktop and mobile clients connected to the server share the selection. An updated desktop client exposes the choice in Manage → Memory → Facts → Reranker; restart a development client after updating its server so the new controls and channel bindings are loaded.

Keep built-in Qwen3 Embedding 0.6B selected. In the Reranker dropdown, choose **Stem GTE Memory** to enable it, or **Qwen3 Reranker 0.6B** to return to Qwen. Selecting Qwen switches both stages back to Qwen. Changes apply on the next turn, without a server restart. Wait for **Ready** before comparing; **Test model** times the selected model on the same small probe. Normal chat timing also includes skill selection, tools, and the LLM.

No environment variable is needed for normal use. The optional model-directory environment variable supplies a preinstalled offline copy; it does not override the dropdown. The persisted `reranker.factModel` field explicitly selects GTE for facts and skills; absent or `configured` means facts and skills use the normal reranker. Switching embeddings away from built-in Qwen pauses GTE.

## Published model

The tested q8 export is public at [join3r/stem-gte-memory](https://huggingface.co/join3r/stem-gte-memory), published on 2026-09-06 under Apache-2.0. Pin revision `dae4f76d6974e70cdc007d3ca66d82226791822f` for this release. Its five inference files match the SHA-256 hashes in `gte-model-artifact.ts`; `stem-model.json` records their sizes, hashes, upstream revisions and separate fact/skill thresholds.

The repository includes a model card, license notices and a tested Node.js inference example. It contains no training datasets or private benchmark text. The inference files total 358,119,455 bytes (341.53 MiB). The app downloads the pinned files only when GTE is selected, verifies SHA-256 hashes and sizes, then loads the verified local copy. Cached valid files work offline. Downloads belong to the retrieval host: a standalone desktop downloads locally; desktop and mobile clients connected to one server share the server copy.

## Automatic installation

Update the desktop client and, when connected remotely, its server. Select **Stem GTE Memory** in the reranker dropdown and wait for **Ready**. Progress appears below the picker and in background activity. Switching away cancels an unfinished download; selecting GTE again reuses already verified files. If downloading fails, **Test model** retries preparation. Existing model selections are preserved; upgrading does not select GTE automatically, the what's-new popup offers it once and the Memory tab's Recall quality row points at it until it is selected.

The model lives under `embed-models/gte-memory-20260905-epoch2` in the host's app data, or under `STEM_EMBED_MODELS_DIR` when configured. Docker uses its persistent model volume. E2E tests disable automatic preparation.

## Optional offline installation

Install the verified `gte-finetune-pilot-20260905/exports/epoch2` q8 export on the server. It needs `config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, and `onnx/model_quantized.onnx`. FP32 weights and training checkpoints are unnecessary. The code verifies SHA-256 hashes for the exact measured files; do not substitute another checkpoint or tokenizer.

Add a read-only bind mount to the existing Compose override, preserving any other mounts and proxy configuration:

```yaml
services:
  stem:
    volumes:
      - /home/join3r/services/stem-models/gte-memory-20260905-epoch2:/var/lib/stem/gte-fact-model:ro
```

Set this in the deployment's `.env`:

```dotenv
STEM_GTE_FACT_MODEL_DIR=/var/lib/stem/gte-fact-model
```

Build the prepared server version and recreate only the Stem service using the deployment's existing Compose files. Keep the previous image for rollback. Wait for active turns and pending approvals to finish before replacing the container.

The dropdown status and activity feed report the experimental memory model preparing or failing. Server logs report `GTE fact pilot ready` and, on applicable recall builds, `experimental fact selection` with model, selection tier, count and whether context was used. These diagnostics omit message and fact text. While selected GTE is preparing or unavailable, Qwen remains the fact fallback; the Test model action reports GTE readiness and never times that fallback as GTE.

## Behavior and limits

- GTE runs in its own worker, loaded from a verified local folder. The downloader pins a specific public Hub revision; the inference worker never fetches model files or executes remote model code. An explicit `STEM_GTE_FACT_MODEL_DIR` stays read-only and is never repaired by downloading.
- The fact floor is −1.6370911598205566, with an additional +2 for sensitive facts. At most 16 relevant facts are selected, respecting a smaller user limit; existing pinned-fact behavior is preserved.
- Fact candidates and reranking use at most two prior eligible user messages from the active conversation branch, clipped to 400 Unicode characters each. Assistant, tool, scheduled/mail, and attachment-bearing history entries are omitted. Missing or unreadable history uses the current message alone.
- Skill selection uses GTE with its separately calibrated raw-logit floor of −3.9743599891662598. Skill queries, episodic search and folder-document search continue using the current message. The trial adds a separate fact query embedding when context is present.
- Private chats and personas with recall disabled do not read history for this trial or retrieve facts. Scheduled/mail deliveries use current-message-only fact selection.
- While verification/loading fails or is incomplete, fact retrieval uses the normally configured reranker. A failure during an already-started GTE selection uses the existing conservative retrieval fallbacks.
- Model quality was measured on local benchmarks and frozen synthetic Linux checks; these do not establish improved live answer quality. The configured Qwen worker remains available as a warm fallback, so these changes do not claim a single-reranker RAM reduction.

## Roll back

Select Qwen3 Reranker 0.6B in the dropdown to switch back immediately. The cached GTE files can remain for later comparisons. Clearing `STEM_GTE_FACT_MODEL_DIR` returns to the managed download path; it does not hide the option. If the code itself needs rolling back, restore the saved server image and its prior Compose configuration.

Do not reset facts, re-embed the memory store, or alter learned facts to toggle this trial.
