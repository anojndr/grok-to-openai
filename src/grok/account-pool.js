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
    this.activeFallbackAccountIndex = null;
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

    try {
      const result = {
        accountIndex: account.index,
        value: await operation(account.client, account.index)
      };

      await this.activateFallbackAccount(account, accounts);
      return result;
    } catch (error) {
      await this.handleFailure(account, accounts);
      throw error;
    }
  }

  async withFallback(operation, options = {}) {
    const accounts = await this.getAccounts();
    const primaryAccount = accounts[0];

    if (!primaryAccount) {
      throw new Error("No Grok accounts configured");
    }

    const fallbackAccounts = this.getFallbackAccounts(accounts);

    if (!fallbackAccounts.length) {
      let lastError = null;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return {
            accountIndex: primaryAccount.index,
            value: await operation(primaryAccount.client, primaryAccount.index)
          };
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError ?? new Error("No Grok accounts configured");
    }

    let lastError = null;
    let exhaustedPasses = 0;

    while (exhaustedPasses < 2) {
      try {
        return {
          accountIndex: primaryAccount.index,
          value: await operation(primaryAccount.client, primaryAccount.index)
        };
      } catch (error) {
        lastError = error;
      }

      const fallbackAccount = this.getActiveFallbackAccount(fallbackAccounts);

      try {
        return {
          accountIndex: fallbackAccount.index,
          value: await operation(fallbackAccount.client, fallbackAccount.index)
        };
      } catch (error) {
        lastError = error;
        const failure = await this.handleFailure(fallbackAccount, accounts);
        if (failure.wrapped) {
          exhaustedPasses += 1;
        }
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

  getFallbackAccounts(accounts) {
    return accounts.slice(1);
  }

  getActiveFallbackAccount(fallbackAccounts) {
    if (!fallbackAccounts.length) {
      return null;
    }

    const activeIndex = fallbackAccounts.findIndex(
      (account) => account.index === this.activeFallbackAccountIndex
    );
    if (activeIndex !== -1) {
      return fallbackAccounts[activeIndex];
    }

    this.activeFallbackAccountIndex = fallbackAccounts[0].index;
    return fallbackAccounts[0];
  }

  async activateFallbackAccount(account, accounts) {
    const primaryAccount = accounts[0];
    if (!primaryAccount || account.index === primaryAccount.index) {
      return;
    }

    const fallbackAccounts = this.getFallbackAccounts(accounts);
    const previousActiveAccount = fallbackAccounts.find(
      (fallbackAccount) => fallbackAccount.index === this.activeFallbackAccountIndex
    );

    this.activeFallbackAccountIndex = account.index;

    if (
      previousActiveAccount &&
      previousActiveAccount.index !== account.index
    ) {
      await previousActiveAccount.client.close?.();
    }
  }

  async handleFailure(account, accounts) {
    const primaryAccount = accounts[0];
    if (!primaryAccount || account.index === primaryAccount.index) {
      return { wrapped: false };
    }

    await account.client.close?.();

    const fallbackAccounts = this.getFallbackAccounts(accounts);
    if (!fallbackAccounts.length) {
      this.activeFallbackAccountIndex = null;
      return { wrapped: false };
    }

    const activeFallbackExists = fallbackAccounts.some(
      (fallbackAccount) => fallbackAccount.index === this.activeFallbackAccountIndex
    );
    if (
      this.activeFallbackAccountIndex !== null &&
      activeFallbackExists &&
      account.index !== this.activeFallbackAccountIndex
    ) {
      return { wrapped: false };
    }

    const currentPosition = fallbackAccounts.findIndex(
      (fallbackAccount) => fallbackAccount.index === account.index
    );
    if (currentPosition === -1) {
      this.activeFallbackAccountIndex = fallbackAccounts[0].index;
      return { wrapped: false };
    }

    const nextPosition = (currentPosition + 1) % fallbackAccounts.length;
    this.activeFallbackAccountIndex = fallbackAccounts[nextPosition].index;
    return { wrapped: nextPosition === 0 };
  }
}
