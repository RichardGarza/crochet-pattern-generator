// The start screen's frame (§5.7): app header, the five "new / import" cards, and the "Your projects" section,
// whose content (`library`) and header buttons (`libraryActions`, e.g. "Restore from folder or backup") come
// from the library entry (ui/library/StartScreen, T8).
import { useRef, type ReactNode } from 'react';
import { useAppStore } from '../../../state/appStore';
import { Icon } from '../../common/Icon';
import { Tooltip } from '../../common/Tooltip';
import { Logo } from '../Logo';
import { ThemeToggle } from '../ThemeToggle';
import { useFocusOnArrival } from '../focusOnArrival';
import { NewProjectCards } from './NewProjectCards';

/** The folder mirror state of §5.5.4, as a quiet note under "Your projects". */
function MirrorStatus() {
  const mirror = useAppStore((s) => s.capabilities.folderMirror);
  if (mirror === null) return null;
  const tip = mirror
    ? 'Every project is also copied to the projects folder on this computer, with dated backups.'
    : 'Projects are not copied to a folder on this computer. That copy is made only when the app is started from its project folder.';
  return (
    <Tooltip content={tip}>
      <span tabIndex={0} className="shell-mirror" data-mirror={mirror ? 'on' : 'off'}>
        <Icon name="folder" size={14} />
        {mirror ? 'Folder mirror on' : 'Folder mirror off'}
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
  const mainRef = useRef<HTMLElement>(null);
  useFocusOnArrival(mainRef);
  return (
    <div className="shell-start">
      <header className="shell-header">
        <div className="shell-header__inner">
          <Logo />
          <div className="shell-header__end">
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="shell-start__main" id="main" tabIndex={-1} ref={mainRef}>
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
              <div className="shell-library__note">
                {libraryNote ? <span>{libraryNote}</span> : null}
                <MirrorStatus />
              </div>
            </div>
            {libraryActions ? <div className="shell-library__actions">{libraryActions}</div> : null}
          </div>
          {library}
        </section>
      </main>
    </div>
  );
}
