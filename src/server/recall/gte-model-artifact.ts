/** Immutable public artifact used by the measured Stem GTE Memory release. */
export const GTE_FACT_PILOT_ID = 'gte-memory-20260905-epoch2';
export const GTE_MODEL_REPO = 'join3r/stem-gte-memory';
export const GTE_MODEL_REVISION = 'dae4f76d6974e70cdc007d3ca66d82226791822f';

export interface GteModelArtifact {
  repo: string;
  revision: string;
  files: Readonly<Record<string, { sha256: string; size: number }>>;
}

export const GTE_MODEL_ARTIFACT: GteModelArtifact = {
  repo: GTE_MODEL_REPO,
  revision: GTE_MODEL_REVISION,
  files: {
    'config.json': { sha256: 'e5f2efd1e04e5e4465b8c6c2f6af1f00a5d66a839e825b0af8edba68ceb8b1bb', size: 1627 },
    'tokenizer.json': { sha256: '3a56def25aa40facc030ea8b0b87f3688e4b3c39eb8b45d5702b3a1300fe2a20', size: 17082734 },
    'tokenizer_config.json': { sha256: '6f00514620aff01ba8b7291b2394e98daca5be264cb743805232d9ae27494b2a', size: 1340 },
    'special_tokens_map.json': { sha256: '8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835', size: 964 },
    'onnx/model_quantized.onnx': { sha256: '5cbb66c672aa71fb6609880ba8e8370ff5be3376fc95215317c92e41e7743e4e', size: 341032790 },
    'LICENSE': { sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30', size: 11358 },
    'NOTICE': { sha256: 'c943475cbb6f4cf48f04e009ba003ebc63b6fc5f7a9c1329bda7ef294bc9bef2', size: 897 }
  }
};

export const GTE_FACT_PILOT_FILES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(GTE_MODEL_ARTIFACT.files)
    .filter(([file]) => file !== 'LICENSE' && file !== 'NOTICE')
    .map(([file, { sha256 }]) => [file, sha256])
);
