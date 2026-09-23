import type { IFileObjectStore } from '@truefoundry/trueforge-core/agent-session';

import type { FileStoreConfiguration } from '../config';
import { FsFileObjectStore } from './FsFileObjectStore';
import { S3FileObjectStore } from './S3FileObjectStore';

/** The Node server's object store for session files, as configured. */
export function createNodeFileObjectStore({
  settings,
  directory,
}: {
  settings: FileStoreConfiguration;
  /** Used by the filesystem backend. */
  directory: string;
}): IFileObjectStore {
  if (settings.FILE_STORE_BACKEND === 'filesystem') {
    return new FsFileObjectStore(directory);
  }
  return new S3FileObjectStore({
    endpoint: settings.FILE_STORE_S3_ENDPOINT,
    bucket: settings.FILE_STORE_S3_BUCKET,
    region: settings.FILE_STORE_S3_REGION,
    access_key_id: settings.FILE_STORE_S3_ACCESS_KEY_ID,
    secret_access_key: settings.FILE_STORE_S3_SECRET_ACCESS_KEY,
    fetch: (input, init) => fetch(input, init),
  });
}
