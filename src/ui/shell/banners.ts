// Project banners (DESIGN.md §5.7, §5.5.2): the messages above the tab bar of the open project. The shell
// derives two by itself — "Waiting for your Claude Design result" (doc.qa.awaiting, F4 step 3) and a plain
// read-only notice (projectStore.readOnly) — and shows whatever persistence (T8) posts here:
//
//   showProjectBanner({ id: 'read-only', kind: 'read-only', tone: 'warn', title: 'Open in another tab',
//     message: 'You can look, but edits are off here.',
//     actions: [{ label: 'Edit here instead', run: requestHandOver }] })        // later: + 'Take over'
//   showProjectBanner({ id: 'conflict', kind: 'conflict-copy', tone: 'info', title: '…', dismissible: true })
//   showProjectBanner({ id: 'reload', kind: 'reload-for-update', tone: 'warn', title: 'This tab was closed for an update',
//     actions: [{ label: 'Reload', run: () => location.reload() }] })
//   showProjectBanner({ id: 'save', kind: 'save-failed', tone: 'danger', title: 'Not saved',
//     actions: [{ label: 'Export a backup', run: exportBackup }] })
//   dismissProjectBanner('save')
//
// A banner posted with kind 'read-only' replaces the shell's own read-only notice. Banners are cleared when
// another project opens (projectStore.session changes).
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { projectStore } from '../../state/projectStore';
import type { BannerTone } from '../common/Banner';

export type ProjectBannerKind = 'read-only' | 'conflict-copy' | 'reload-for-update' | 'save-failed' | 'info';

export interface ProjectBannerAction {
  label: string;
  run(): void;
  /** Default: the first action 'secondary', the others 'ghost'. */
  variant?: 'primary' | 'secondary' | 'ghost';
}

export interface ProjectBanner {
  /** Showing a banner with the id of one that shows replaces it. */
  id: string;
  kind: ProjectBannerKind;
  tone: BannerTone;
  title: string;
  message?: string;
  actions?: ProjectBannerAction[];
  /** Shows a close button (dismissProjectBanner). */
  dismissible?: boolean;
}

interface BannerState {
  banners: ProjectBanner[];
}

export const bannerStore = createStore<BannerState>()(() => ({ banners: [] }));

export function showProjectBanner(banner: ProjectBanner): void {
  const { banners } = bannerStore.getState();
  const at = banners.findIndex((b) => b.id === banner.id);
  bannerStore.setState({ banners: at >= 0 ? banners.map((b, i) => (i === at ? banner : b)) : [...banners, banner] });
}

export function dismissProjectBanner(id: string): void {
  const { banners } = bannerStore.getState();
  if (banners.some((b) => b.id === id)) bannerStore.setState({ banners: banners.filter((b) => b.id !== id) });
}

export function clearProjectBanners(): void {
  if (bannerStore.getState().banners.length > 0) bannerStore.setState({ banners: [] });
}

export function useProjectBanners(): ProjectBanner[] {
  return useStore(bannerStore, (s) => s.banners);
}

projectStore.subscribe((s, prev) => {
  if (s.session !== prev.session) clearProjectBanners();
});
