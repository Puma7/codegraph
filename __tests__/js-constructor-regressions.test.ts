import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { matchJsSuperCall } from '../src/resolution/js-constructor-methods';
import * as stripping from '../src/resolution/strip-comments';
import type { ResolutionContext } from '../src/resolution/types';

let root: string | undefined;
let graph: CodeGraph | undefined;
afterEach(() => { vi.restoreAllMocks(); graph?.close(); if (root) fs.rmSync(root, { recursive: true, force: true }); });
async function index(files: Record<string, string>) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-constructor-regressions-'));
  for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root, file), source);
  graph = await CodeGraph.init(root, { index: true });
  return graph;
}
function targets(cg: CodeGraph, name: string) {
  const caller = [...cg.getNodesByKind('function'), ...cg.getNodesByKind('method')].find(n => n.qualifiedName === name)!;
  return cg.getOutgoingEdges(caller.id).filter(e => e.kind === 'calls').map(e => cg.getNode(e.target)!.qualifiedName);
}
it('preserves both separately scoped unaliased receiver branches', async () => {
  const cg = await index({ 'types.js': 'export class A { extract() {} } export class B { extract() {} }',
    'consumer.js': "import {A,B} from './types';\nfunction invoke(flag) {\n if (flag) {\n const extractor = new A();\n return extractor.extract();\n } else {\n const extractor = new B();\n return extractor.extract();\n }\n}" });
  expect(targets(cg, 'invoke')).toEqual(expect.arrayContaining(['A::extract', 'B::extract']));
});
it('does not call a static method on a constructed instance', async () => {
  const cg = await index({ 'left.js': 'export class Left { static show() {} }',
    'consumer.js': "import {Left as Known} from './left'; function invoke() { const item = new Known(); return item.show(); }" });
  expect(targets(cg, 'invoke')).not.toContain('Left::show');
});
it('does not use an implements class as the runtime superclass', async () => {
  const cg = await index({ 'shape.ts': 'export class Shape { run() {} }',
    'consumer.ts': "import {Ext} from 'external'; import {Shape} from './shape'; class C extends Ext implements Shape { run() { return super.run(); } }" });
  expect(targets(cg, 'C::run')).not.toContain('Shape::run');
});
it('resolves a static super call to the static parent method', async () => {
  const cg = await index({ 'example.js': 'class Base { static run() {} } class C extends Base { static run() { return super.run(); } }' });
  expect(targets(cg, 'C::run')).toContain('Base::run');
});
it('strips source once for thousands of super call sites', () => {
  const count = 4000;
  const source = 'class C extends Base { run() {\n' + '  super.run();\n'.repeat(count) + '} }\n';
  const cls = { id: 'c', kind: 'class', name: 'C', qualifiedName: 'C', filePath: 'example.js', startLine: 1, endLine: count + 3, startColumn: 0, endColumn: 4 };
  const parent = { ...cls, id: 'base', name: 'Base', qualifiedName: 'Base', filePath: 'base.js' };
  const method = { ...parent, id: 'run', kind: 'method', name: 'run', qualifiedName: 'Base::run', startLine: 1, endLine: 1, isStatic: false };
  const context = { getFileLines: () => source.split('\n'), readFile: () => source, getNodesInFile: () => [cls],
    getSuperclassNodes: (id: string) => id === 'c' ? [parent] : [], getMethodMatches: () => [method] } as unknown as ResolutionContext;
  const spy = vi.spyOn(stripping, 'stripCommentsForRegex');
  for (let i = 0; i < count; i++) expect(matchJsSuperCall({ fromNodeId: 'caller', referenceName: 'run', referenceKind: 'calls', filePath: 'example.js', language: 'javascript', line: i + 2, column: 2 }, context)?.targetNodeId).toBe('run');
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0]![0].length).toBe(source.length);
});
