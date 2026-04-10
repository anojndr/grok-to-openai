import { ensureDir } from "../lib/fs.js";
import { FileStore } from "./file-store.js";
import { PostgresStorage } from "./postgres.js";
import { ResponseStore } from "./response-store.js";

export async function createStores(config) {
  if (config.databaseUrl) {
    const storage = new PostgresStorage(config.databaseUrl);
    await storage.init();
    return {
      backend: "postgresql",
      fileStore: storage.fileStore,
      responseStore: storage.responseStore,
      close: async () => storage.close()
    };
  }

  await ensureDir(config.dataDir);

  const fileStore = new FileStore(config.dataDir);
  await fileStore.init();

  const responseStore = new ResponseStore(config.dataDir);
  await responseStore.init();

  return {
    backend: "filesystem",
    fileStore,
    responseStore,
    close: async () => {}
  };
}
