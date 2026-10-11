import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

const LANGUAGES = new Set(['javascript', 'jsx', 'typescript', 'tsx', 'arkts']);
const owners = new WeakMap<ResolutionContext, Map<string, Map<string, Node>>>();

export function clearClassExpressionMemos(context: ResolutionContext): void {
  owners.delete(context);
}

/** Named class expressions bind their inner name only inside the expression. */
export function gateClassExpression(
  resolved: ResolvedRef | null, ref: UnresolvedRef, context: ResolutionContext,
): ResolvedRef | null {
  if (!resolved || !LANGUAGES.has(ref.language)) return resolved;
  const target = context.getNodeById?.(resolved.targetNodeId);
  if (!target || (target.kind !== 'class' && target.kind !== 'method')) return resolved;
  let files = owners.get(context);
  if (!files) owners.set(context, files = new Map());
  let byId = files.get(target.filePath);
  if (!byId) {
    byId = new Map();
    const nodes = context.getNodesInFile(target.filePath);
    // Only expressions carry a class header in signature. Declarations retain
    // their existing representation, and the marker survives DB round-trips.
    const expressions = nodes.filter(n => n.kind === 'class' && /^class\b/.test(n.signature ?? ''));
    for (const n of nodes) {
      if (n.kind !== 'class' && n.kind !== 'method') continue;
      const owner = expressions.filter(c => encloses(c, n.startLine, n.startColumn) &&
        encloses(c, n.endLine, n.endColumn)).sort((a, b) => b.startLine - a.startLine || b.startColumn - a.startColumn)[0];
      if (owner) byId.set(n.id, owner);
    }
    files.set(target.filePath, byId);
  }
  const owner = byId.get(target.id);
  if (!owner || (ref.filePath === owner.filePath && encloses(owner, ref.line, ref.column))) return resolved;
  // A proven instance receiver may expose methods of the returned class value;
  // it does not make the expression's inner class name visible to the caller.
  if (target.kind === 'method' && resolved.resolvedBy === 'instance-method' &&
      ref.referenceName.includes('.') && ref.referenceName.split('.')[0] !== owner.name) return resolved;
  return null;
}

function encloses(node: Node, line: number, column: number): boolean {
  return (line > node.startLine || (line === node.startLine && column >= node.startColumn)) &&
    (line < node.endLine || (line === node.endLine && column <= node.endColumn));
}
