// The start screen's frame (§5.7): app header, the five "new / import" cards, and the "Your projects" section,
// whose content (`library`) and header buttons (`libraryActions`, e.g. "Restore from folder or backup") come
// from the library entry (ui/library/StartScreen, T8).
import type { ReactNode } from 'react';
import { useAppStore } from '../../../state/appStore';
import { Badge } from '../../common/Badge';
import { Tooltip } from '../../common/Tooltip';
import { Logo } from '../Logo';
import { ThemeToggle } from '../ThemeToggle';
import { NewProjectCards } from './NewProjectCards';

function MirrorStatus() {
  const mirror = useAppStore((s) => s.capabilities.folderMirror);
  if (mirror === null) return null;
  return mirror ? (
    <Tooltip content="Every project is also copied to the projects folder on this computer, with dated backups.">
      <span tabIndex={0} className="shell-header__status">
        <Badge tone="success" icon="folder" size="sm">
          Folder mirror on
        </Badge>
      </span>
    </Tooltip>
  ) : (
    <Tooltip content="Projects are kept in this browser only. The folder copy works when the app runs from its own dev or preview server.">
      <span tabIndex={0} className="shell-header__status">
        <Badge tone="neutral" icon="folder" size="sm" variant="outline">
          Folder mirror off
        </Badge>
      </span>
    </Tooltip>
  );
}

export interface StartLayoutProps {
  /** The "Your projects" content: a ProjectGrid or an empty state. */
  library: ReactNode;
  /** Buttons at the right of the "Your projects" heading. */
  libraryActions?: ReactNode;
  /** A line under the heading (e.g. how many projects, storage notes). */
  libraryNote?: ReactNode;
}

export function StartLayout({ library, libraryActions, libraryNote }: StartLayoutProps) {
  return (
    <div className="shell-start">
      <header className="shell-header">
        <div className="shell-header__inner">
          <Logo />
          <div className="shell-header__end">
            <MirrorStatus />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="shell-start__main" id="main" tabIndex={-1}>
        <section className="shell-hero" aria-labelledby="start-title">
          <h1 className="shell-hero__title" id="start-title">
            What would you like to make?
          </h1>
          <p className="shell-hero__lede">Turn a picture, a few photos or a 3D model into a complete, checked crochet pattern — sized for your yarn and hook. Everything runs on this computer.</p>
        </section>
        <NewProjectCards />
        <section className="shell-library" aria-labelledby="library-title">
          <div className="shell-library__head">
            <div>
              <h2 className="shell-library__title" id="library-title">
                Your projects
              </h2>
              {libraryNote ? <p className="shell-library__note">{libraryNote}</p> : null}
            </div>
            {libraryActions ? <div className="shell-library__actions">{libraryActions}</div> : null}
          </div>
          {library}
        </section>
      </main>
    </div>
  );
}
