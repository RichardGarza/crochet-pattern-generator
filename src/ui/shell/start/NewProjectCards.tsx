// The five "new / import" cards of the start screen (§5.7), grouped by what they make: a colorwork chart (2D)
// or an amigurumi toy (3D). Each creates a project and opens its first view.
import { useState } from 'react';
import { navigate } from '../../../app/router';
import { defaultRouteTab } from '../../../app/tabs';
import { notify } from '../../../app/toasts';
import { Badge } from '../../common/Badge';
import { CardButton } from '../../common/Card';
import { NEW_PROJECT_OPTIONS, type NewProjectKind } from '../newProject';
import { createProject } from '../projectSession';
import { HeartChartArt, ToyArt } from './ChartArt';

export function NewProjectCards() {
  const [busy, setBusy] = useState<NewProjectKind | null>(null);

  const start = async (kind: NewProjectKind) => {
    if (busy) return;
    setBusy(kind);
    try {
      const doc = await createProject(kind);
      navigate({ screen: 'project', projectId: doc.id, tab: defaultRouteTab(doc) });
    } catch (error) {
      notify.error(`Could not start the project: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const [picture, ...threeD] = NEW_PROJECT_OPTIONS;
  const tone = { photos: 'accent', 'one-photo': 'accent', describe: 'info', 'claude-design': 'info' } as const;

  return (
    <div className="shell-new">
      <section className="shell-new__group shell-new__group--2d" aria-labelledby="new-2d-title">
        <h2 className="shell-new__label" id="new-2d-title">
          Colorwork chart
          <span className="shell-new__label-mode">2D</span>
        </h2>
        <CardButton
          className="shell-new__feature"
          title={picture.title}
          description={picture.description}
          icon={picture.icon}
          aria-busy={busy === picture.kind || undefined}
          onClick={() => void start(picture.kind)}
          data-kind={picture.kind}
          footer={
            <>
              <Badge size="sm">Graphgan</Badge>
              <Badge size="sm">Tapestry</Badge>
              <Badge size="sm">C2C</Badge>
            </>
          }
        >
          <span className="shell-new__art">
            <HeartChartArt />
          </span>
        </CardButton>
      </section>
      <section className="shell-new__group shell-new__group--3d" aria-labelledby="new-3d-title">
        <h2 className="shell-new__label" id="new-3d-title">
          Amigurumi toy
          <span className="shell-new__label-mode">3D</span>
          <span className="shell-new__label-art">
            <ToyArt size={34} />
          </span>
        </h2>
        <div className="shell-new__grid">
          {threeD.map((o) => (
            <CardButton
              key={o.kind}
              title={o.title}
              description={o.description}
              icon={o.icon}
              tone={tone[o.kind as keyof typeof tone]}
              aria-busy={busy === o.kind || undefined}
              onClick={() => void start(o.kind)}
              data-kind={o.kind}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
