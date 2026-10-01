// Track T6 — the Parts outliner (DESIGN.md §4.1): the model's attach tree. A WAI-ARIA tree view: one tab stop,
// ↑/↓ move (and select), → opens a branch or goes to its first child, ← closes it or goes to the parent,
// Home/End, Enter/Space select, ⇧+Enter/Space and ⇧-click add to the selection. Hovering a row highlights the
// part in the 3D view; selecting a part in the view opens its branch and scrolls its row into view.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { ancestorIds, partName, partTree, visibleRows, type PartNode } from '../../state/slices/model3d';
import type { Issue } from '../../types/issues';
import type { CrochetModelV1 } from '../../types/model';
import { Badge, Icon, Panel, Sidebar, cx } from '../common';
import { TYPE_NAMES } from './dimSpecs';
import { editorStore, useEditorStore } from './editorStore';

export interface OutlinerProps {
  model: CrochetModelV1;
  issues: readonly Issue[];
}

export function Outliner({ model, issues }: OutlinerProps) {
  const selection = useEditorStore((s) => s.selection);
  const collapsed = useEditorStore((s) => s.collapsed);
  const hovered = useEditorStore((s) => s.hovered);
  const tree = useMemo(() => partTree(model), [model]);
  const rows = useMemo(() => visibleRows(tree, collapsed), [tree, collapsed]);
  const colors = useMemo(() => new Map(model.palette.map((c) => [c.id, c.hex])), [model.palette]);
  const warned = useMemo(() => new Map(issues.filter((i) => i.where?.part).map((i) => [i.where!.part!, i.message])), [issues]);
  const primary = selection[selection.length - 1] ?? null;
  const [focusId, setFocusId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const treeRef = useRef<HTMLUListElement>(null);

  // The row that holds the tab stop: the focused one, else the primary selection, else the first row.
  const tabStop = rows.find((r) => r.id === focusId)?.id ?? rows.find((r) => r.id === primary)?.id ?? rows[0]?.id ?? null;

  // A part selected elsewhere (the 3D view): open its branch and bring its row into view.
  useEffect(() => {
    if (!primary) return;
    const closed = ancestorIds(model, primary).filter((id) => collapsed.has(id));
    for (const id of closed) editorStore.getState().toggleCollapsed(id, false);
    const el = rowRefs.current.get(primary);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary]);

  const focusRow = (id: string | undefined) => {
    if (!id) return;
    setFocusId(id);
    rowRefs.current.get(id)?.focus();
  };

  const select = (id: string, additive: boolean) => editorStore.getState().select(id, { additive });

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>, node: PartNode) => {
    const i = rows.findIndex((r) => r.id === node.id);
    const open = node.children.length > 0 && !collapsed.has(node.id);
    let target: string | undefined;
    switch (e.key) {
      case 'ArrowDown':
        target = rows[i + 1]?.id;
        break;
      case 'ArrowUp':
        target = rows[i - 1]?.id;
        break;
      case 'Home':
        target = rows[0]?.id;
        break;
      case 'End':
        target = rows[rows.length - 1]?.id;
        break;
      case 'ArrowRight':
        if (node.children.length === 0) return;
        e.preventDefault();
        if (!open) editorStore.getState().toggleCollapsed(node.id, false);
        else {
          focusRow(node.children[0].id);
          if (!e.shiftKey) select(node.children[0].id, false);
        }
        return;
      case 'ArrowLeft': {
        e.preventDefault();
        const parent = node.part.attach?.to;
        if (open) editorStore.getState().toggleCollapsed(node.id, true);
        else if (parent && rows.some((r) => r.id === parent)) {
          focusRow(parent);
          if (!e.shiftKey) select(parent, false);
        }
        return;
      }
      case 'Enter':
      case ' ':
        e.preventDefault();
        select(node.id, e.shiftKey);
        return;
      default:
        return;
    }
    e.preventDefault();
    if (!target) return;
    focusRow(target);
    // Selection follows the focus (like a layers list); ⇧ keeps the selection as it is.
    if (!e.shiftKey) select(target, false);
  };

  return (
    <Sidebar>
      <Panel
        title="Parts"
        icon="layers"
        actions={
          <Badge tone="neutral" size="sm" icon={null}>
            {model.parts.length}
          </Badge>
        }
      >
        <p className="shape-hint shape-outliner__hint">Indented parts are attached to the part above them and move with it.</p>
        <ul ref={treeRef} role="tree" aria-label="Parts" aria-multiselectable="true" className="shape-tree">
          {tree.map((node) => (
            <TreeRow
              key={node.id}
              node={node}
              collapsed={collapsed}
              selection={selection}
              primary={primary}
              hovered={hovered}
              tabStop={tabStop}
              colors={colors}
              warned={warned}
              rowRefs={rowRefs.current}
              onFocusRow={setFocusId}
              onKeyDown={onKeyDown}
              onSelect={select}
            />
          ))}
        </ul>
      </Panel>
    </Sidebar>
  );
}

interface RowProps {
  node: PartNode;
  collapsed: ReadonlySet<string>;
  selection: readonly string[];
  primary: string | null;
  hovered: string | null;
  tabStop: string | null;
  colors: ReadonlyMap<string, string>;
  warned: ReadonlyMap<string, string>;
  rowRefs: Map<string, HTMLLIElement>;
  onFocusRow(id: string): void;
  onKeyDown(e: KeyboardEvent<HTMLLIElement>, node: PartNode): void;
  onSelect(id: string, additive: boolean): void;
}

function TreeRow(props: RowProps) {
  const { node, collapsed, selection, primary, hovered, tabStop, colors, warned, rowRefs, onFocusRow, onKeyDown, onSelect } = props;
  const hasChildren = node.children.length > 0;
  const open = hasChildren && !collapsed.has(node.id);
  const selected = selection.includes(node.id);
  const warning = warned.get(node.id);
  const name = partName(node.part);
  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    editorStore.getState().toggleCollapsed(node.id);
  };
  return (
    <li
      ref={(el) => {
        if (el) rowRefs.set(node.id, el);
        else rowRefs.delete(node.id);
      }}
      role="treeitem"
      aria-level={node.depth + 1}
      aria-selected={selected}
      aria-expanded={hasChildren ? open : undefined}
      aria-label={`${name}${warning ? ', has a gap to its parent' : ''}`}
      tabIndex={tabStop === node.id ? 0 : -1}
      data-part={node.id}
      className="shape-tree__item"
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocusRow(node.id);
      }}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget) onKeyDown(e, node);
      }}
    >
      <div
        className={cx(
          'shape-tree__row',
          selected && 'shape-tree__row--selected',
          primary === node.id && 'shape-tree__row--primary',
          hovered === node.id && 'shape-tree__row--hover',
        )}
        style={{ paddingLeft: `calc(${node.depth} * 18px + var(--space-1))` }}
        onClick={(e) => onSelect(node.id, e.shiftKey)}
        onPointerEnter={() => editorStore.getState().setHovered(node.id)}
        onPointerLeave={() => {
          if (editorStore.getState().hovered === node.id) editorStore.getState().setHovered(null);
        }}
      >
        <span className={cx('shape-tree__twisty', !hasChildren && 'shape-tree__twisty--leaf')} onClick={hasChildren ? toggle : undefined} aria-hidden="true">
          {hasChildren ? <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} /> : null}
        </span>
        <span className="shape-swatch" style={{ background: colors.get(node.part.color) ?? 'transparent' }} aria-hidden="true" />
        <span className="shape-tree__name">{name}</span>
        <span className="shape-tree__type" aria-hidden="true">
          {TYPE_NAMES[node.part.type]}
        </span>
        {warning ? (
          <span className="shape-tree__warn" title={warning}>
            <Icon name="warning" size={14} label="Gap to its parent" />
          </span>
        ) : null}
      </div>
      {open ? (
        <ul role="group" className="shape-tree__group">
          {node.children.map((child) => (
            <TreeRow key={child.id} {...props} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
