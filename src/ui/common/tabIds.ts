/** The ids that link a tab and its panel (Tabs / TabPanel). */
export function tabIds(idBase: string, id: string): { tab: string; panel: string } {
  return { tab: `${idBase}-tab-${id}`, panel: `${idBase}-panel-${id}` };
}
