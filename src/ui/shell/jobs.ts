// Names of derivedStore jobs as the status bar shows them.
const JOB_LABEL: Record<string, string> = {
  chart: 'Chart',
  pattern2d: 'Pattern',
  recon: '3D build',
  ami: 'Amigurumi pattern',
  depth: 'Depth detail',
  import: 'Import',
};

export function jobLabel(name: string): string {
  return JOB_LABEL[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}
