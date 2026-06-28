import { describe, expect, it } from 'vitest'
import {
  buildSyncPlan,
  SyncPlanError,
  type BookmarkInput,
  type FolderInput,
  type PlanTreeNode,
  type SyncInput,
} from './folder-tree-builder.js'

// ─── Test helpers ─────────────────────────────────────────────────────────

function folder(chromeId: string, parentChromeId: string | null, name: string): FolderInput {
  return { chromeId, parentChromeId, name }
}

function bookmark(
  chromeId: string,
  folderChromeId: string,
  url = `https://${chromeId}.example.com`,
  title = `Bookmark ${chromeId}`,
): BookmarkInput {
  return { chromeId, folderChromeId, url, title }
}

/** Collect every folder chromeId from a tree in pre-order (folder first,
 *  then its descendants). Useful for asserting insertion order. */
function treeFolderChromeIds(tree: readonly PlanTreeNode[]): string[] {
  const ids: string[] = []
  function walk(nodes: readonly PlanTreeNode[]) {
    for (const node of nodes) {
      if (node.kind === 'folder') {
        ids.push(node.chromeId)
        walk(node.children)
      }
    }
  }
  walk(tree)
  return ids
}

// ─── Empty input ─────────────────────────────────────────────────────────

describe('buildSyncPlan — empty input', () => {
  it('returns an empty plan for {folders:[], bookmarks:[]}', () => {
    const plan = buildSyncPlan({ folders: [], bookmarks: [] })
    expect(plan.sortedFolders).toEqual([])
    expect(plan.bookmarks).toEqual([])
    expect(plan.tree).toEqual([])
    expect(plan.foldersByChromeId.size).toBe(0)
  })
})

// ─── Single root ─────────────────────────────────────────────────────────

describe('buildSyncPlan — single root', () => {
  it('handles one root folder with no bookmarks', () => {
    const input: SyncInput = {
      folders: [folder('f1', null, 'Bookmarks bar')],
      bookmarks: [],
    }
    const plan = buildSyncPlan(input)
    expect(plan.sortedFolders).toHaveLength(1)
    expect(plan.sortedFolders[0]).toEqual({
      chromeId: 'f1',
      parentChromeId: null,
      name: 'Bookmarks bar',
    })
    expect(plan.tree).toHaveLength(1)
    expect(plan.tree[0]?.kind).toBe('folder')
    if (plan.tree[0]?.kind === 'folder') {
      expect(plan.tree[0].name).toBe('Bookmarks bar')
      expect(plan.tree[0].children).toEqual([])
    }
  })

  it('handles one root folder with multiple bookmarks attached', () => {
    const input: SyncInput = {
      folders: [folder('f1', null, 'News')],
      bookmarks: [
        bookmark('b1', 'f1'),
        bookmark('b2', 'f1'),
      ],
    }
    const plan = buildSyncPlan(input)
    expect(plan.bookmarks).toHaveLength(2)
    expect(plan.tree).toHaveLength(1)
    const root = plan.tree[0]
    if (root?.kind === 'folder') {
      expect(root.children).toHaveLength(2)
      expect(root.children[0]?.kind).toBe('bookmark')
      if (root.children[0]?.kind === 'bookmark') {
        expect(root.children[0].chromeId).toBe('b1')
      }
      expect(root.children[1]?.kind).toBe('bookmark')
    }
  })
})

// ─── Deep nesting ────────────────────────────────────────────────────────

describe('buildSyncPlan — deep nesting', () => {
  it('returns folders in topological order (parents before children)', () => {
    // Input intentionally in child-first order to verify sort works.
    const input: SyncInput = {
      folders: [
        folder('a1a', 'a1', 'A1a'),  // deepest
        folder('a1', 'a', 'A1'),     // middle
        folder('a', null, 'A'),      // root
        folder('b', null, 'B'),      // sibling root
      ],
      bookmarks: [],
    }
    const plan = buildSyncPlan(input)

    // Every folder appears exactly once, in correct order.
    expect(plan.sortedFolders.map((f) => f.chromeId)).toEqual([
      'a',
      'a1',
      'a1a',
      'b',
    ])

    // Tree shape reflects nesting.
    expect(plan.tree).toHaveLength(2)
    const rootA = plan.tree.find((n) => n.kind === 'folder' && n.chromeId === 'a')
    const rootB = plan.tree.find((n) => n.kind === 'folder' && n.chromeId === 'b')
    expect(rootA?.kind).toBe('folder')
    if (rootA?.kind === 'folder') {
      expect(rootA.children).toHaveLength(1)
      const a1 = rootA.children[0]
      expect(a1?.kind).toBe('folder')
      if (a1?.kind === 'folder') {
        expect(a1.children).toHaveLength(1)
        expect(a1.children[0]?.kind).toBe('folder')
        if (a1.children[0]?.kind === 'folder') {
          expect(a1.children[0].chromeId).toBe('a1a')
          expect(a1.children[0].children).toEqual([])
        }
      }
    }
    expect(rootB?.kind).toBe('folder')
    if (rootB?.kind === 'folder') {
      expect(rootB.children).toEqual([])
    }
  })

  it('handles a 5-level chain correctly', () => {
    const input: SyncInput = {
      folders: [
        folder('L1', null, 'L1'),
        folder('L2', 'L1', 'L2'),
        folder('L3', 'L2', 'L3'),
        folder('L4', 'L3', 'L4'),
        folder('L5', 'L4', 'L5'),
      ],
      bookmarks: [],
    }
    const plan = buildSyncPlan(input)
    expect(plan.sortedFolders.map((f) => f.chromeId)).toEqual([
      'L1',
      'L2',
      'L3',
      'L4',
      'L5',
    ])

    // Walk to the leaf to verify nesting.
    let node: PlanTreeNode | undefined = plan.tree[0]
    let depth = 0
    while (node && node.kind === 'folder' && node.children.length > 0) {
      node = node.children[0]
      depth++
    }
    expect(node?.kind).toBe('folder')
    expect((node as { chromeId: string }).chromeId).toBe('L5')
    expect(depth).toBe(4) // L1 → L2 → L3 → L4 → L5 = 4 hops
  })

  it('attaches bookmarks to deeply nested folders', () => {
    const input: SyncInput = {
      folders: [
        folder('a', null, 'A'),
        folder('b', 'a', 'B'),
        folder('c', 'b', 'C'),
      ],
      bookmarks: [bookmark('deep', 'c')],
    }
    const plan = buildSyncPlan(input)
    // Walk to the deepest folder and verify bookmark is attached.
    const deepest = treeFolderChromeIds(plan.tree)
    expect(deepest).toEqual(['a', 'b', 'c'])

    let node: PlanTreeNode | undefined = plan.tree[0]
    while (node && node.kind === 'folder') {
      if (node.chromeId === 'c') {
        expect(node.children).toHaveLength(1)
        expect(node.children[0]?.kind).toBe('bookmark')
        if (node.children[0]?.kind === 'bookmark') {
          expect(node.children[0].chromeId).toBe('deep')
        }
      }
      node = node.children[0]
    }
  })
})

// ─── Duplicates ──────────────────────────────────────────────────────────

describe('buildSyncPlan — duplicates', () => {
  it('rejects duplicate folder chromeIds with code duplicate_folder_id', () => {
    const input: SyncInput = {
      folders: [
        folder('dup', null, 'First'),
        folder('dup', 'something-else', 'Second'),
      ],
      bookmarks: [],
    }
    expect(() => buildSyncPlan(input)).toThrow(SyncPlanError)
    try {
      buildSyncPlan(input)
    } catch (err) {
      expect(err).toBeInstanceOf(SyncPlanError)
      expect((err as SyncPlanError).code).toBe('duplicate_folder_id')
      expect((err as SyncPlanError).message).toContain('dup')
    }
  })
})

// ─── Re-parenting ────────────────────────────────────────────────────────

describe('buildSyncPlan — re-parenting', () => {
  it('handles non-trivial parent relationships (re-parented child)', () => {
    // A child whose parent would normally be in another branch is moved
    // here. The builder treats each input independently — re-parenting
    // just means "this folder's parent is now X".
    const input: SyncInput = {
      folders: [
        folder('root1', null, 'Root 1'),
        folder('root2', null, 'Root 2'),
        folder('child', 'root2', 'Child of Root 2'), // re-parented to root2
      ],
      bookmarks: [],
    }
    const plan = buildSyncPlan(input)
    expect(plan.sortedFolders).toHaveLength(3)
    expect(plan.foldersByChromeId.get('child')?.parentChromeId).toBe('root2')

    // Verify nesting: child should appear under root2, not root1.
    const root2 = plan.tree.find(
      (n) => n.kind === 'folder' && n.chromeId === 'root2',
    )
    const root1 = plan.tree.find(
      (n) => n.kind === 'folder' && n.chromeId === 'root1',
    )
    expect(root1?.kind).toBe('folder')
    if (root1?.kind === 'folder') expect(root1.children).toEqual([])
    expect(root2?.kind).toBe('folder')
    if (root2?.kind === 'folder') {
      expect(root2.children).toHaveLength(1)
      expect(root2.children[0]?.kind).toBe('folder')
      if (root2.children[0]?.kind === 'folder') {
        expect(root2.children[0].chromeId).toBe('child')
      }
    }
  })
})

// ─── Reordering (input arrives out of order) ────────────────────────────

describe('buildSyncPlan — reordering', () => {
  it('sorts children-first input into parent-first plan', () => {
    const input: SyncInput = {
      folders: [
        folder('c1', 'p', 'C1'),
        folder('c2', 'p', 'C2'),
        folder('p', null, 'P'),
      ],
      bookmarks: [],
    }
    const plan = buildSyncPlan(input)
    // Parent must come before children in the sorted output, regardless
    // of input order.
    expect(plan.sortedFolders.map((f) => f.chromeId)).toEqual(['p', 'c1', 'c2'])
  })

  it('preserves sibling order within a parent', () => {
    const input: SyncInput = {
      folders: [
        folder('p', null, 'P'),
        folder('z', 'p', 'Z'),
        folder('a', 'p', 'A'),
        folder('m', 'p', 'M'),
      ],
      bookmarks: [],
    }
    const plan = buildSyncPlan(input)
    const root = plan.tree[0]
    expect(root?.kind).toBe('folder')
    if (root?.kind === 'folder') {
      expect(root.children.map((c) => (c as { chromeId: string }).chromeId)).toEqual([
        'z',
        'a',
        'm',
      ])
    }
  })
})

// ─── Cycle detection ─────────────────────────────────────────────────────

describe('buildSyncPlan — cycle detection', () => {
  it('rejects a 2-node cycle with code cycle_detected', () => {
    const input: SyncInput = {
      folders: [
        folder('a', 'b', 'A'),
        folder('b', 'a', 'B'),
      ],
      bookmarks: [],
    }
    expect(() => buildSyncPlan(input)).toThrow(SyncPlanError)
    try {
      buildSyncPlan(input)
    } catch (err) {
      expect((err as SyncPlanError).code).toBe('cycle_detected')
    }
  })

  it('rejects a 3-node cycle', () => {
    const input: SyncInput = {
      folders: [
        folder('a', 'c', 'A'),
        folder('b', 'a', 'B'),
        folder('c', 'b', 'C'),
      ],
      bookmarks: [],
    }
    expect(() => buildSyncPlan(input)).toThrow(SyncPlanError)
    try {
      buildSyncPlan(input)
    } catch (err) {
      expect((err as SyncPlanError).code).toBe('cycle_detected')
    }
  })

  it('does not flag a shared grandchild as a cycle', () => {
    // Two siblings that share a grandchild is NOT a cycle.
    const input: SyncInput = {
      folders: [
        folder('p1', null, 'P1'),
        folder('p2', null, 'P2'),
        folder('g', 'p1', 'G'), // G's parent is p1
      ],
      bookmarks: [],
    }
    const plan = buildSyncPlan(input)
    expect(plan.sortedFolders.map((f) => f.chromeId)).toEqual(['p1', 'p2', 'g'])
  })
})

// ─── Validation of dangling references ───────────────────────────────────

describe('buildSyncPlan — dangling references', () => {
  it('rejects folder with unknown parent with code unknown_parent', () => {
    const input: SyncInput = {
      folders: [
        folder('orphan', 'missing-parent', 'Orphan'),
      ],
      bookmarks: [],
    }
    expect(() => buildSyncPlan(input)).toThrow(SyncPlanError)
    try {
      buildSyncPlan(input)
    } catch (err) {
      expect((err as SyncPlanError).code).toBe('unknown_parent')
      expect((err as SyncPlanError).message).toContain('missing-parent')
    }
  })

  it('rejects bookmark with unknown folder with code unknown_bookmark_folder', () => {
    const input: SyncInput = {
      folders: [folder('f1', null, 'F1')],
      bookmarks: [bookmark('b1', 'nonexistent')],
    }
    expect(() => buildSyncPlan(input)).toThrow(SyncPlanError)
    try {
      buildSyncPlan(input)
    } catch (err) {
      expect((err as SyncPlanError).code).toBe('unknown_bookmark_folder')
    }
  })
})

// ─── foldersByChromeId helper ────────────────────────────────────────────

describe('buildSyncPlan — foldersByChromeId', () => {
  it('exposes a chromeId → FolderPlanEntry map for O(1) lookup', () => {
    const input: SyncInput = {
      folders: [
        folder('a', null, 'A'),
        folder('b', 'a', 'B'),
      ],
      bookmarks: [],
    }
    const plan = buildSyncPlan(input)
    expect(plan.foldersByChromeId.size).toBe(2)
    expect(plan.foldersByChromeId.get('a')?.name).toBe('A')
    expect(plan.foldersByChromeId.get('b')?.parentChromeId).toBe('a')
    expect(plan.foldersByChromeId.get('does-not-exist')).toBeUndefined()
  })
})

// ─── Bookmarks pass-through ──────────────────────────────────────────────

describe('buildSyncPlan — bookmarks', () => {
  it('preserves bookmark order in the plan', () => {
    const input: SyncInput = {
      folders: [folder('f', null, 'F')],
      bookmarks: [
        bookmark('third', 'f'),
        bookmark('first', 'f'),
        bookmark('second', 'f'),
      ],
    }
    const plan = buildSyncPlan(input)
    expect(plan.bookmarks.map((b) => b.chromeId)).toEqual([
      'third',
      'first',
      'second',
    ])
  })

  it('preserves optional createdAt and updatedAt fields', () => {
    const input: SyncInput = {
      folders: [folder('f', null, 'F')],
      bookmarks: [
        {
          ...bookmark('b', 'f'),
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-06-15T12:34:56.000Z',
        },
      ],
    }
    const plan = buildSyncPlan(input)
    expect(plan.bookmarks[0]?.createdAt).toBe('2024-01-01T00:00:00.000Z')
    expect(plan.bookmarks[0]?.updatedAt).toBe('2024-06-15T12:34:56.000Z')
  })
})