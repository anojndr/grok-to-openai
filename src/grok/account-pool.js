import path from "node:path";
import fs from "node:fs/promises";
import { readCookieSetsFromSource } from "../lib/cookies.js";
import { GrokClient } from "./client.js";
import { GROK_SESSION_BLOCKED_ERROR_CODE } from "./browser-session.js";

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
    this.unavailableAccountIndexes = new Set();
    this.unavailableAccountTimestamps = new Map();
    this.lastLoadedContent = "";
    this.loadedAccounts = null;
  }

  isAccountUnavailable(index, cooldownMs = 15 * 60 * 1000) {
    if (!this.unavailableAccountIndexes.has(index)) {
      return false;
    }
    const timestamp = this.unavailableAccountTimestamps.get(index);
    if (timestamp && Date.now() - timestamp > cooldownMs) {
      this.unavailableAccountIndexes.delete(index);
      this.unavailableAccountTimestamps.delete(index);
      return false;
    }
    return true;
  }

  checkPoolExhaustion(accounts) {
    if (!accounts || accounts.length === 0) {
      return false;
    }
    for (const index of Array.from(this.unavailableAccountIndexes)) {
      this.isAccountUnavailable(index);
    }
    if (this.unavailableAccountIndexes.size >= accounts.length) {
      console.warn(`All ${accounts.length} configured accounts in pool are marked as unavailable. Resetting pool status to retry them.`);
      this.unavailableAccountIndexes.clear();
      this.unavailableAccountTimestamps.clear();
      this.accountsPromise = null; // Clear cached promise to trigger a reload of cookies on next request
      return true;
    }
    return false;
  }

  async init() {
    const accounts = await this.getAccounts();
    const primaryAccount = this.getPrimaryAccount(accounts);
    if (primaryAccount) {
      await primaryAccount.client.init();
    }
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

    const rawText = this.config.grokCookiesText ?? "";
    let content = "";
    if (rawText.trim()) {
      content = rawText;
    } else if (this.config.grokCookieFile) {
      try {
        content = await fs.readFile(this.config.grokCookieFile, "utf8");
      } catch (e) {
        content = "";
      }
    }

    if (this.lastLoadedContent === content && this.loadedAccounts) {
      return this.loadedAccounts;
    }

    // Clean up old clients if config/content changed
    if (this.loadedAccounts) {
      await Promise.all(this.loadedAccounts.map((acc) => acc.client.close?.()));
    }

    const cookieSets = await readCookieSetsFromSource({
      filePath: this.config.grokCookieFile,
      rawText: this.config.grokCookiesText
    });

    if (!cookieSets.length) {
      this.lastLoadedContent = content;
      this.loadedAccounts = [
        {
          index: 0,
          client: this.clientFactory(this.config)
        }
      ];
      return this.loadedAccounts;
    }

    this.lastLoadedContent = content;
    this.loadedAccounts = cookieSets.map((cookies, index) => {
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

    return this.loadedAccounts;
  }

  async withAccount(accountIndex, operation) {
    const accounts = await this.getAccounts();
    this.checkPoolExhaustion(accounts);

    const normalizedIndex = Number.isInteger(accountIndex) ? accountIndex : 0;
    const account = accounts[normalizedIndex];

    if (!account) {
      throw new Error(`Unknown Grok account index: ${accountIndex}`);
    }

    if (this.isAccountUnavailable(account.index)) {
      return this.withFallback(operation);
    }

    try {
      const result = {
        accountIndex: account.index,
        value: await operation(account.client, account.index)
      };

      await this.activateFallbackAccount(account, accounts);
      return result;
    } catch (error) {
      if (this.isSessionUnavailableError(error)) {
        await this.handleFailure(account, accounts, error);
        return this.withFallback(operation);
      }

      await this.handleFailure(account, accounts, error);
      throw error;
    }
  }

  async withFallback(operation, options = {}) {
    const accounts = await this.getAccounts();
    this.checkPoolExhaustion(accounts);

    let primaryAccount = this.getPrimaryAccount(accounts);

    if (!primaryAccount && !this.getFallbackAccounts(accounts).length) {
      throw new Error("No Grok accounts configured");
    }

    let fallbackAccounts = this.getFallbackAccounts(accounts);

    if (!fallbackAccounts.length) {
      let lastError = null;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        primaryAccount = this.getPrimaryAccount(accounts);
        if (!primaryAccount) {
          break;
        }

        try {
          return {
            accountIndex: primaryAccount.index,
            value: await operation(primaryAccount.client, primaryAccount.index)
          };
        } catch (error) {
          lastError = error;
          await this.handleFailure(primaryAccount, accounts, error);
        }
      }

      throw lastError ?? new Error("No Grok accounts configured");
    }

    let lastError = null;
    let exhaustedPasses = 0;

    while (exhaustedPasses < 2) {
      primaryAccount = this.getPrimaryAccount(accounts);
      if (primaryAccount) {
        try {
          return {
            accountIndex: primaryAccount.index,
            value: await operation(primaryAccount.client, primaryAccount.index)
          };
        } catch (error) {
          lastError = error;
          await this.handleFailure(primaryAccount, accounts, error);
        }
      }

      fallbackAccounts = this.getFallbackAccounts(accounts);
      if (!fallbackAccounts.length) {
        break;
      }

      const fallbackAccount = this.getActiveFallbackAccount(fallbackAccounts);

      try {
        return {
          accountIndex: fallbackAccount.index,
          value: await operation(fallbackAccount.client, fallbackAccount.index)
        };
      } catch (error) {
        lastError = error;
        const failure = await this.handleFailure(fallbackAccount, accounts, error);
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
    this.checkPoolExhaustion(accounts);
    return accounts
      .slice(1)
      .filter((account) => !this.isAccountUnavailable(account.index));
  }

  getPrimaryAccount(accounts) {
    this.checkPoolExhaustion(accounts);
    const primaryAccount = accounts[0];
    if (!primaryAccount) {
      return null;
    }

    return this.isAccountUnavailable(primaryAccount.index)
      ? null
      : primaryAccount;
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

  async handleFailure(account, accounts, error = null) {
    if (this.isSessionUnavailableError(error)) {
      this.unavailableAccountIndexes.add(account.index);
      this.unavailableAccountTimestamps.set(account.index, Date.now());
      await account.client.close?.();

      if (account.index === this.activeFallbackAccountIndex) {
        const fallbackAccounts = this.getFallbackAccounts(accounts);
        this.activeFallbackAccountIndex = fallbackAccounts[0]?.index ?? null;
      }

      return { wrapped: false };
    }

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

  isSessionUnavailableError(error) {
    if (!error) {
      return false;
    }

    if (error.details?.code === GROK_SESSION_BLOCKED_ERROR_CODE) {
      return true;
    }

    if (
      error.status === 401 ||
      error.status === 403 ||
      error.status === 429 ||
      error.status === 503
    ) {
      return true;
    }

    const message = String(error.message || "").toLowerCase();
    if (
      message.includes("too many requests") ||
      message.includes("rate limit") ||
      message.includes("rate_limit") ||
      message.includes("rate-limit") ||
      message.includes("limit reached") ||
      message.includes("reached your limit") ||
      message.includes("exceeded limit") ||
      message.includes("heavy usage") ||
      message.includes("try again later") ||
      message.includes("upgrade plan") ||
      message.includes("resourceexhausted") ||
      message.includes("overload") ||
      message.includes("admission denied") ||
      message.includes("load_shed") ||
      message.includes("unauthenticated") ||
      message.includes("unauthorized") ||
      message.includes("login required") ||
      message.includes("sign in") ||
      message.includes("session expired") ||
      message.includes("session_expired") ||
      message.includes("invalid session") ||
      message.includes("invalid_session") ||
      message.includes("auth_error") ||
      message.includes("forbidden") ||
      message.includes("401") ||
      message.includes("403") ||
      message.includes("redirected to login page") ||
      message.includes("grok session is blocked or not authenticated")
    ) {
      return true;
    }

    return false;
  }
}
