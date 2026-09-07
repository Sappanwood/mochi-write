export const bundleLimits = {
  documentBytes: 1024 * 1024,
  manifestBytes: 16 * 1024 * 1024,
  batchBytes: 16 * 1024 * 1024,
  files: 1000,
};
export function bundleFileByteLimit(path: string) {
  return path === "manifest.json"
    ? bundleLimits.manifestBytes
    : bundleLimits.documentBytes;
}
