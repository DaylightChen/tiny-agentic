// Minimal ambient types for `picomatch` v4 (ships no bundled types, and
// @types/picomatch is not installed). Only the surface this package uses.
declare module "picomatch" {
  interface PicomatchOptions {
    dot?: boolean;
    nocase?: boolean;
    windows?: boolean;
  }
  type Matcher = (input: string) => boolean;
  function picomatch(glob: string | string[], options?: PicomatchOptions): Matcher;
  export = picomatch;
}
