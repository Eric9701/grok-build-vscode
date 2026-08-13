import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AcpClient, type ModelInfo } from "./acp";
import { CodexBackend, type CodexBackendOptions } from "./codex-backend";

export interface WarmCodexModelCacheOptions {
  cliPath: string;
  onModels: (models: readonly ModelInfo[], currentModelId?: string) => void | PromiseLike<void>;
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  backend?: CodexBackendOptions;
}

export async function warmCodexModelCache(options: WarmCodexModelCacheOptions): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), "grok-codex-models-"));
  const client = new AcpClient({
    cliPath: options.cliPath,
    cwd: scratch,
    env: options.env ?? { ...process.env },
    backend: new CodexBackend(options.backend),
    log: options.log ?? (() => {}),
  });
  try {
    await client.start();
    const created = await client.newSession();
    await options.onModels(client.availableModels, client.currentModelId);
    await client.deleteSession(created.sessionId);
  } finally {
    try {
      await client.dispose();
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}
