/** Hand `blob` to the browser as a download named `name`. */
export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** `watercolor-<date-time>.<ext>` */
export const stampedName = (ext: string) => `watercolor-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`;

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
