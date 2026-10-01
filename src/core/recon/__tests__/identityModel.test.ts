// The tiny committed ONNX Identity model used by the ml.worker smoke test (e2e/tracks/t3-workers.spec.ts, DESIGN.md
// §5.4) and, later, by the depth unit tests (§2.9.4). Checked here byte-structurally (a minimal protobuf walk), so
// an accidental edit is caught without loading ONNX Runtime in node.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MODEL = fileURLToPath(new URL('./fixtures/identity/onnx/model.onnx', import.meta.url));

interface Field {
  field: number;
  wire: number;
  value: number | Uint8Array;
}

/** Top-level fields of a protobuf message (varint and length-delimited wire types only). */
function fields(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let p = 0;
  const varint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = buf[p++];
      v += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return v;
      shift += 7;
    }
  };
  while (p < buf.length) {
    const key = varint();
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) out.push({ field, wire, value: varint() });
    else if (wire === 2) {
      const len = varint();
      out.push({ field, wire, value: buf.subarray(p, p + len) });
      p += len;
    } else throw new Error(`unexpected wire type ${wire}`);
  }
  return out;
}

const text = (v: Field['value']): string => new TextDecoder().decode(v as Uint8Array);
const one = (list: Field[], n: number): Field['value'] => {
  const f = list.filter((x) => x.field === n);
  expect(f.length, `field ${n}`).toBe(1);
  return f[0].value;
};

describe('the Identity ONNX model fixture', () => {
  const bytes = new Uint8Array(fs.readFileSync(MODEL));

  it('is tiny', () => {
    expect(bytes.length).toBe(111);
  });

  it('is ModelProto { ir_version 8, opset 13, graph: y = Identity(x), x and y float32 [n] }', () => {
    const model = fields(bytes);
    expect(one(model, 1)).toBe(8); // ir_version
    const opset = fields(one(model, 8) as Uint8Array);
    expect(text(one(opset, 1))).toBe(''); // the default ONNX domain
    expect(one(opset, 2)).toBe(13);
    const graph = fields(one(model, 7) as Uint8Array);
    const node = fields(one(graph, 1) as Uint8Array);
    expect([text(one(node, 1)), text(one(node, 2)), text(one(node, 4))]).toEqual(['x', 'y', 'Identity']);
    for (const [n, name] of [
      [11, 'x'],
      [12, 'y'],
    ] as const) {
      const info = fields(one(graph, n) as Uint8Array);
      expect(text(one(info, 1))).toBe(name);
      const tensor = fields(one(fields(one(info, 2) as Uint8Array), 1) as Uint8Array);
      expect(one(tensor, 1)).toBe(1); // FLOAT
      const dim = fields(one(fields(one(tensor, 2) as Uint8Array), 1) as Uint8Array);
      expect(text(one(dim, 2))).toBe('n');
    }
  });
});
