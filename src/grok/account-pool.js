import path from "node:path";
import { readCookieSetsFromSource } from "../lib/cookies.js";
import { GrokClient } from "./client.js";

function buildAccountProfileDir(browserProfileDir, accountIndex, accountCount) {
  if (!browserProfileDir || accountCount <= 1) {
    return browserProfileDir;
  }

  return path.join(
    browserProfileDir,
    `account-${String(accountIndex + 1).padStart(3, "0")}`
  );
}

export class GrokAccountPool {
  constructor(config, options = {}) {
    this.config = config;
    this.fixedAccounts = options.accounts ?? null;
    this.clientFactory =
      options.clientFactory ?? ((accountConfig) => new GrokClient(accountConfig));
    this.accountsPromise = null;
  }

  async getAccounts() {
    if (this.accountsPromise) {
      return this.accountsPromise;
    }

    this.accountsPromise = this.loadAccounts();
    return this.accountsPromise;
  }

  async loadAccounts() {
    if (this.fixedAccounts) {
      return this.fixedAccounts.map((client, index) => ({
        index,
        client
      }));
    }

    const cookieSets = await readCookieSetsFromSource({
      filePath: this.config.grokCookieFile,
      rawText: this.config.grokCookiesText
    });

    if (!cookieSets.length) {
      return [
        {
          index: 0,
          client: this.clientFactory(this.config)
        }
      ];
    }

    return cookieSets.map((cookies, index) => {
      const accountConfig = {
        ...this.config,
        grokCookieFile: "",
        grokCookiesText: "",
        grokCookies: cookies,
        browserProfileDir: buildAccountProfileDir(
          this.config.browserProfileDir,
          index,
          cookieSets.length
        )
      };

      return {
        index,
        client: this.clientFactory(accountConfig)
      };
    });
  }

  async withAccount(accountIndex, operation) {
    const accounts = await this.getAccounts();
    const normalizedIndex = Number.isInteger(accountIndex) ? accountIndex : 0;
    const account = accounts[normalizedIndex];

    if (!account) {
      throw new Error(`Unknown Grok account index: ${accountIndex}`);
    }

    return {
      accountIndex: account.index,
      value: await operation(account.client, account.index)
    };
  }

  async withFallback(operation, options = {}) {
    const accounts = await this.getAccounts();
    const requestedOrder = options.accountIndices ?? accounts.map((account) => account.index);
    const accountOrder = requestedOrder.map((accountIndex) => {
      const account = accounts[accountIndex];
      if (!account) {
        throw new Error(`Unknown Grok account index: ${accountIndex}`);
      }
      return account;
    });

    let lastError = null;

    for (const account of accountOrder) {
      try {
        return {
          accountIndex: account.index,
          value: await operation(account.client, account.index)
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error("No Grok accounts configured");
  }

  async fetchAssetAsBase64(url, { accountIndex = 0 } = {}) {
    const result = await this.withAccount(accountIndex, (client) =>
      client.fetchAssetAsBase64(url)
    );
    return result.value;
  }

  async fetchAsset(url, { accountIndex = 0 } = {}) {
    const result = await this.withAccount(accountIndex, (client) =>
      client.fetchAsset(url)
    );
    return result.value;
  }

  async close() {
    const accounts = await this.getAccounts();
    await Promise.all(accounts.map((account) => account.client.close?.()));
  }
}
