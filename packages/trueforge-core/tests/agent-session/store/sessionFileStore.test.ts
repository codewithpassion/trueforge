import { InMemoryFileObjectStore } from '../../../src/agent-session/store/InMemoryFileStore';
import { runFileStoreContractSuite } from './fileStoreContractSuite';

describe('SessionFileStore over InMemoryFileObjectStore (IFileStore contract)', () => {
  runFileStoreContractSuite(() => new InMemoryFileObjectStore());
});
