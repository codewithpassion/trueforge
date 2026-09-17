import type { CodeModeDispatcher } from '@truefoundry/trueforge-core/core/sandbox/codeMode/CodeModeDispatcher';
import type {
  CodeModeClientInstall,
  CodeModeTransport,
} from '@truefoundry/trueforge-core/core/sandbox/codeMode/CodeModeTransport';
import { sandboxScripts } from '@truefoundry/trueforge-core/core/sandbox/sandboxScripts.gen';
import { CODE_MODE_BRIDGE_URL, type CodeModeBridgeRegistry } from './codeModeBridge';
import { COMPUTER_MCP_CLIENT_BIN, COMPUTER_MCP_CLIENT_PATH } from './computerPaths';

/**
 * Code Mode over the container's own egress: the MCP client posts to a hostname only this
 * workspace's gateway answers, and the token it carries is what opens the channel for one turn.
 */
export class CloudflareComputerCodeModeTransport implements CodeModeTransport {
  readonly #registry: CodeModeBridgeRegistry;
  readonly #maxRequestTimeoutSeconds: number;
  #token: string | undefined;

  constructor(options: { registry: CodeModeBridgeRegistry; maxRequestTimeoutSeconds: number }) {
    this.#registry = options.registry;
    this.#maxRequestTimeoutSeconds = options.maxRequestTimeoutSeconds;
  }

  getClientInstall(): CodeModeClientInstall {
    return {
      content: sandboxScripts.mcpClient,
      // The module lives on the workspace, which outlives the container; the CLI link does not.
      remotePath: COMPUTER_MCP_CLIENT_PATH,
      pathBinSymlink: COMPUTER_MCP_CLIENT_BIN,
    };
  }

  start(params: {
    codeModeDispatcher: CodeModeDispatcher;
    sandboxId: string;
    requestTimeoutSeconds: number;
  }): Promise<{ env: Record<string, string> }> {
    // The command waiting on the reply is killed at the exec timeout, and that exec is itself
    // bounded by the alarm pass holding the turn, so the client has to give up before either.
    const requestTimeoutSeconds = Math.min(params.requestTimeoutSeconds, this.#maxRequestTimeoutSeconds);
    const token = (this.#token ??= this.#registry.open({
      dispatcher: params.codeModeDispatcher,
      timeoutMs: requestTimeoutSeconds * 1000,
    }));
    return Promise.resolve({
      env: {
        TFY_CM_HTTP_URL: CODE_MODE_BRIDGE_URL,
        TFY_CM_HTTP_TOKEN: token,
        TFY_CM_REQUEST_TIMEOUT_SECONDS: String(requestTimeoutSeconds),
      },
    });
  }

  stop(): Promise<void> {
    const token = this.#token;
    this.#token = undefined;
    if (token !== undefined) {
      this.#registry.close(token);
    }
    return Promise.resolve();
  }
}
