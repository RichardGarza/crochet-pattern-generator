// Track T3 — ml.worker: optional depth (Depth Anything V2 Small) and click-to-segment (SlimSAM) through transformers.js,
// loaded lazily; progress goes through a Comlink.proxy callback; ORT paths as absolute URLs to /ort/ (DESIGN.md
// §2.9.1, §2.9.4, §5.4).
//
// T3.1: the ONNX Runtime configuration of §5.4 and a self-test (`ortSelfTest`) that creates an inference session
// from a tiny Identity model and runs it, used by e2e/tracks/t3-workers.spec.ts. `status`, `depth`, `samEncode` and
// `samMask` are still stubs (T3.4); they reject with NotImplementedError.
import { stub } from '../core/stub';
import type { MlApi } from '../types/workers';
import { exposeApi } from './rpc';

type Transformers = typeof import('@huggingface/transformers');

/**
 * §5.4: the ORT wasm pair as an OBJECT of absolute URLs. Vite 8 dev rewrites a non-literal `import('/ort/…mjs')`
 * built from a path prefix to `…?import`, and answers it with HTTP 500 for files in `public/`; absolute http(s)
 * URLs are left alone. `env.useWasmCache` is honoured only in this object form.
 */
function ortWasmPaths(origin: string): { mjs: string; wasm: string } {
  return {
    mjs: new URL('/ort/ort-wasm-simd-threaded.asyncify.mjs', origin).href,
    wasm: new URL('/ort/ort-wasm-simd-threaded.asyncify.wasm', origin).href,
  };
}

let transformers: Promise<Transformers> | undefined;

/**
 * transformers.js, imported on first use (it is ≈ 1 MB of code plus the ORT bundle) and configured once. A failed
 * import is not kept, so the next call tries again.
 */
function loadTransformers(): Promise<Transformers> {
  if (transformers === undefined) {
    const attempt = import('@huggingface/transformers').then((t) => {
      const onnx = t.env.backends.onnx;
      if (!onnx.wasm) throw new Error('ml.worker: ONNX Runtime has no wasm backend in this build of transformers.js');
      onnx.wasm.wasmPaths = ortWasmPaths(self.location.origin);
      // No cross-origin isolation (D20): one thread, no proxy worker.
      onnx.wasm.numThreads = 1;
      onnx.wasm.proxy = false;
      t.env.useWasmCache = true;
      return t;
    });
    attempt.catch(() => {
      if (transformers === attempt) transformers = undefined;
    });
    transformers = attempt;
  }
  return transformers;
}

/** What `ortSelfTest` reports. */
export interface OrtSelfTest {
  /**
   * The ORT wasm paths this worker configured (the object form of §5.4). After the first session, transformers.js
   * replaces `mjs` in its env with a `blob:` URL of the cached factory, so this is what was set, not what is read
   * back; the e2e spec checks the requests themselves.
   */
  wasmPaths: { mjs: string; wasm: string };
  inputNames: string[];
  outputNames: string[];
  /** The model's output for the input `[1, 2, 3.5, -4]`; an Identity model returns it unchanged. */
  output: number[];
  dims: number[];
}

/**
 * Loads the model `<modelBase>/<modelId>/onnx/model.onnx` from this origin (no remote models, no browser cache),
 * creates its ORT session on the wasm backend through transformers.js — the same path the depth and SlimSAM models
 * take — and runs it once on `x = [1, 2, 3.5, -4]`. Test support (e2e/tracks/t3-workers.spec.ts); not part of
 * `MlApi`. The transformers.js settings it changes are restored afterwards; it must not run while a depth or SAM
 * model loads (those read the same global `env`).
 */
async function ortSelfTest(o: { modelBase: string; modelId: string }): Promise<OrtSelfTest> {
  const t = await loadTransformers();
  const { env } = t;
  const saved = {
    allowLocalModels: env.allowLocalModels,
    allowRemoteModels: env.allowRemoteModels,
    localModelPath: env.localModelPath,
    useBrowserCache: env.useBrowserCache,
  };
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = new URL(o.modelBase, self.location.origin).pathname;
  env.useBrowserCache = false;
  try {
    // model_type 'custom' = a single `onnx/model.onnx` session, without the "unknown model type" warning.
    const model = await t.PreTrainedModel.from_pretrained(o.modelId, {
      config: { model_type: 'custom' } as never,
      local_files_only: true,
      device: 'wasm',
      dtype: 'fp32',
    });
    try {
      const session = (model.sessions as Record<string, { inputNames: string[]; outputNames: string[] }>).model;
      const x = new t.Tensor('float32', Float32Array.from([1, 2, 3.5, -4]), [4]);
      const out = (await model({ x })) as Record<string, { data: ArrayLike<number>; dims: number[] }>;
      const y = out[session.outputNames[0]];
      return {
        wasmPaths: ortWasmPaths(self.location.origin),
        inputNames: [...session.inputNames],
        outputNames: [...session.outputNames],
        output: Array.from(y.data),
        dims: [...y.dims],
      };
    } finally {
      await model.dispose();
    }
  } finally {
    Object.assign(env, saved);
  }
}

exposeApi<MlApi>(() => {
  const methods: Omit<MlApi, 'supersede'> & { ortSelfTest: typeof ortSelfTest } = {
    status: stub<MlApi['status']>('MlApi.status'),
    depth: stub<MlApi['depth']>('MlApi.depth'),
    samEncode: stub<MlApi['samEncode']>('MlApi.samEncode'),
    samMask: stub<MlApi['samMask']>('MlApi.samMask'),
    ortSelfTest,
  };
  return methods;
});
