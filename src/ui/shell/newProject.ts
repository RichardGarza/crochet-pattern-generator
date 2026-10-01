// New projects from the start screen's five cards (DESIGN.md §5.7, flows F1–F4). A new project is a valid
// `ProjectDoc` with no sources yet: the first tab then asks for the picture, the photos or the Claude Design
// result. Pure (the caller passes id, time and preferences), so it is unit-tested.
import type { Prefs } from '../../state/appStore';
import type { AmiSettings } from '../../types/ami';
import type { ProjectDoc } from '../../types/project';
import type { IconName } from '../common/Icon';

export type NewProjectKind = 'picture' | 'photos' | 'one-photo' | 'describe' | 'claude-design';

export interface NewProjectOption {
  kind: NewProjectKind;
  /** The card's title (§5.7 wording). */
  title: string;
  description: string;
  icon: IconName;
  mode: '2d' | '3d';
  /** `threeD.origin` of a 3D project. */
  origin?: NonNullable<ProjectDoc['threeD']>['origin'];
  /** Name of the new project until the user renames it. */
  defaultName: string;
}

export const NEW_PROJECT_OPTIONS: readonly NewProjectOption[] = [
  {
    kind: 'picture',
    title: 'New pattern from a picture',
    description: 'Turn an image into a colorwork chart — graphgan, tapestry or corner-to-corner — with written rows and yarn amounts.',
    icon: 'image',
    mode: '2d',
    defaultName: 'Untitled chart',
  },
  {
    kind: 'photos',
    title: 'New 3D toy from photos',
    description: 'Photograph a toy from two or more sides; get an amigurumi pattern with every piece and round.',
    icon: 'images',
    mode: '3d',
    origin: 'multiview',
    defaultName: 'Untitled toy',
  },
  {
    kind: 'one-photo',
    title: 'New 3D toy from one photo',
    description: 'One clear photo is enough: the 3D-ifier fills in the depth, and you adjust it.',
    icon: 'camera',
    mode: '3d',
    origin: 'single',
    defaultName: 'Untitled toy',
  },
  {
    kind: 'describe',
    title: 'Describe a toy for Claude Design',
    description: 'Answer a few questions and get a ready prompt for Claude Design; bring the result back here.',
    icon: 'message',
    mode: '3d',
    origin: 'describe',
    defaultName: 'Untitled toy idea',
  },
  {
    kind: 'claude-design',
    title: 'Import from Claude Design',
    description: 'Open a 3D model or a Claude Design export (.zip, .html, .glb, .obj, .json) and make it crochet-ready.',
    icon: 'import',
    mode: '3d',
    origin: 'claude-design',
    defaultName: 'Claude Design import',
  },
];

export function newProjectOption(kind: NewProjectKind): NewProjectOption {
  const option = NEW_PROJECT_OPTIONS.find((o) => o.kind === kind);
  if (!option) throw new Error(`unknown project kind ${kind}`);
  return option;
}

/** Amigurumi defaults (§2.10, §2.11.2): classic shaping, continuous spiral, invisible decrease, firm stuffing. */
export function defaultAmiSettings(prefs: Pick<Prefs, 'dialect' | 'terms' | 'hand'>): AmiSettings {
  return {
    style: 'classic',
    spiral: true,
    crispStripes: false,
    decMethod: 'invdec',
    dialect: prefs.dialect,
    terms: prefs.terms,
    hand: prefs.hand,
    eyes: 'auto',
    defaultStuffing: 'firm',
    leanStPerRnd: 0.25,
  };
}

/**
 * A new, empty project of `kind`. 2D: worsted (CYC 4) single crochet graphgan, the Table A defaults; the
 * chart settings arrive with the picture (T2's Source tab). 3D: worsted amigurumi, no model yet.
 */
export function newProjectDoc(kind: NewProjectKind, o: { id: string; now: Date; prefs: Pick<Prefs, 'units' | 'terms' | 'hand' | 'dialect'>; name?: string }): ProjectDoc {
  const option = newProjectOption(kind);
  const at = o.now.toISOString();
  const base = {
    schema: 'crochet-project' as const,
    version: 1 as const,
    id: o.id,
    name: o.name ?? option.defaultName,
    createdAt: at,
    updatedAt: at,
    rev: 0,
    units: o.prefs.units,
    terms: o.prefs.terms,
    hand: o.prefs.hand,
    sources: [],
    imports: [],
  };
  if (option.mode === '2d') {
    return { ...base, mode: '2d', gauge: { cyc: 4, technique: 'sc_graphgan' } };
  }
  return {
    ...base,
    mode: '3d',
    gauge: { cyc: 4, technique: 'amigurumi_sc' },
    threeD: { origin: option.origin ?? 'multiview', meshAssets: {}, revisions: [], views: [], ami: defaultAmiSettings(o.prefs) },
  };
}
