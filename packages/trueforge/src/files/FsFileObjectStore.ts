import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { IFileObjectStore } from '@truefoundry/trueforge-core/agent-session';

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/**
 * Objects as files under one directory, a key's `/` segments becoming directories. The directory is
 * created on first write, so a server that never stores a file needs it to be neither present nor
 * writable. The media type lives in `session_file`, so no sidecar is kept.
 */
export class FsFileObjectStore implements IFileObjectStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  /** Keys come from `sessionFileKey`, which cannot escape; this still refuses one that would. */
  #path(key: string): string {
    const resolved = path.resolve(this.#root, ...key.split('/'));
    if (!resolved.startsWith(`${this.#root}${path.sep}`)) {
      throw new Error(`File store key escapes its root: ${JSON.stringify(key)}`);
    }
    return resolved;
  }

  async put({ key, bytes }: { key: string; media_type: string; bytes: Uint8Array }): Promise<void> {
    const target = this.#path(key);
    await mkdir(path.dirname(target), { recursive: true });
    // Written aside and renamed, so a reader never sees a partial file.
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes);
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.#path(key)));
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    const slash = prefix.lastIndexOf('/');
    const directory = slash === -1 ? this.#root : this.#path(prefix.slice(0, slash));
    const namePrefix = prefix.slice(slash + 1);
    if (namePrefix === '' && directory !== this.#root) {
      // A whole directory, as for a session's files: remove it rather than leave it empty.
      await rm(directory, { recursive: true, force: true });
      return;
    }
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
    await Promise.all(
      names
        .filter(name => name.startsWith(namePrefix))
        .map(name => rm(path.join(directory, name), { recursive: true, force: true })),
    );
  }
}
