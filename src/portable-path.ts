/** Portable logical paths shared by contracts and filesystem adapters. No OS calls. */
export function portablePath(path: string): boolean {
  return !!path && path.length <= 2048 && !/[\\:\u0000-\u001f<>"|?*]/.test(path) && !path.split('/').some(part =>
    !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
