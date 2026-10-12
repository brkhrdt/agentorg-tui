export interface VolumeChoice { name: string; destination?: string; description?: string; readOnly: boolean }
/** Reusable server-choice filtering; no local filesystem/Podman lookup. */
export function filterVolumes(choices: VolumeChoice[], query: string, writable: boolean): VolumeChoice[] {
  const needle = query.toLowerCase();
  return choices.filter(choice => {
    if (writable && choice.readOnly) return false;
    let at = 0;
    for (const ch of choice.name.toLowerCase()) if (ch === needle[at]) at++;
    return at === needle.length;
  }).sort((a, b) => Number(b.name === query) - Number(a.name === query) || a.name.localeCompare(b.name));
}
