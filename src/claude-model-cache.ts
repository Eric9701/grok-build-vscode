import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AcpClient, type ModelInfo } from "./acp";
import { ClaudeBackend, type ClaudeBackendOptions } from "./claude-backend";

export interface WarmClaudeModelCacheOptions {
  cliPath: string;
  onModels: (models: readonly ModelInfo[], currentModelId?: string) => void | PromiseLike<void>;
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  backend?: ClaudeBackendOptions;
}

export async function warmClaudeModelCache(options: WarmClaudeModelCacheOptions): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), "grok-claude-models-"));
  const client = new AcpClient({
    cliPath: options.cliPath,
    cwd: scratch,
    env: options.env ?? { ...process.env },
    backend: new ClaudeBackend(options.backend),
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
