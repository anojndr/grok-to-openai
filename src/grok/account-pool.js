import path from "node:path";
import fs from "node:fs/promises";
import { parseCookieSets } from "../lib/cookies.js";
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
    this.lastLoadedContent = null;
    this.lastReloadWarning = null;
    this.loadedAccounts = null;
    this.activeClientOperations = new Map();
    this.pendingClientCloses = new Set();
    this.clientClosePromises = new Map();
    this.knownClients = new Set();
    this.closed = false;
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
      this.activeFallbackAccountIndex = null;
      void this.closeAccountsWhenIdle(accounts);
      return true;
    }
    return false;
  }

  async init() {
    const accounts = await this.getAccounts();
    const primaryAccount = this.getPrimaryAccount(accounts);
    if (primaryAccount) {
      await this.runAccountOperation(primaryAccount, (client) => client.init());
    }
  }

  async getAccounts() {
    if (this.closed) {
      throw new Error("Grok account pool is closed");
    }

    if (this.accountsPromise) {
      return this.accountsPromise;
    }

    const accountsPromise = this.loadAccounts();
    this.accountsPromise = accountsPromise;

    try {
      return await accountsPromise;
    } finally {
      if (this.accountsPromise === accountsPromise) {
        this.accountsPromise = null;
      }
    }
  }

  async loadAccounts() {
    if (this.fixedAccounts) {
      if (!this.loadedAccounts) {
        this.loadedAccounts = this.fixedAccounts.map((client, index) => ({
          index,
          client
        }));
        this.trackAccounts(this.loadedAccounts);
      }
      return this.loadedAccounts;
    }

    let content;
    try {
      content = await this.readConfiguredCookieText();
    } catch (error) {
      if (!this.loadedAccounts) {
        throw error;
      }

      this.warnReloadFailure(
        `Failed to reload Grok cookies; continuing with the last known-good account pool: ${error.message}`
      );
      return this.loadedAccounts;
    }

    if (this.lastLoadedContent === content && this.loadedAccounts) {
      this.lastReloadWarning = null;
      return this.loadedAccounts;
    }

    let cookieSets;
    try {
      cookieSets = parseCookieSets(content);
    } catch (error) {
      if (!this.loadedAccounts) {
        throw error;
      }

      this.warnReloadFailure(
        `Ignoring invalid Grok cookie update; continuing with the last known-good account pool: ${error.message}`
      );
      return this.loadedAccounts;
    }

    let nextAccounts;
    try {
      nextAccounts = await this.createAccounts(cookieSets);
    } catch (error) {
      if (!this.loadedAccounts) {
        throw error;
      }

      this.warnReloadFailure(
        `Failed to build the updated Grok account pool; continuing with the last known-good pool: ${error.message}`
      );
      return this.loadedAccounts;
    }
    const previousAccounts = this.loadedAccounts;

    this.lastLoadedContent = content;
    this.lastReloadWarning = null;
    this.loadedAccounts = nextAccounts;
    this.activeFallbackAccountIndex = null;
    this.unavailableAccountIndexes.clear();
    this.unavailableAccountTimestamps.clear();
    this.trackAccounts(nextAccounts);

    if (previousAccounts) {
      void this.closeAccountsWhenIdle(previousAccounts);
    }

    return nextAccounts;
  }

  warnReloadFailure(message) {
    if (this.lastReloadWarning === message) {
      return;
    }

    this.lastReloadWarning = message;
    console.warn(message);
  }

  async readConfiguredCookieText() {
    const rawText = this.config.grokCookiesText ?? "";
    if (rawText.trim()) {
      return rawText;
    }

    if (!this.config.grokCookieFile) {
      return "";
    }

    try {
      return await fs.readFile(this.config.grokCookieFile, "utf8");
    } catch (error) {
      if (
        error?.code === "ENOENT" &&
        (!this.loadedAccounts || this.lastLoadedContent === "")
      ) {
        return "";
      }
      throw error;
    }
  }

  async createAccounts(cookieSets) {
    const accounts = [];

    try {
      if (!cookieSets.length) {
        accounts.push({
          index: 0,
          client: this.clientFactory(this.config)
        });
        return accounts;
      }

      for (const [index, cookies] of cookieSets.entries()) {
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

        accounts.push({
          index,
          client: this.clientFactory(accountConfig)
        });
      }

      return accounts;
    } catch (error) {
      await Promise.allSettled(
        accounts.map((account) => account.client.close?.())
      );
      throw error;
    }
  }

  trackAccounts(accounts) {
    for (const account of accounts) {
      this.knownClients.add(account.client);
    }
  }

  async runAccountOperation(account, operation) {
    if (this.closed) {
      throw new Error("Grok account pool is closed");
    }

    const client = account.client;
    const closePromise = this.clientClosePromises.get(client);
    if (closePromise) {
      await closePromise;
    } else if (
      this.pendingClientCloses.has(client) &&
      !this.activeClientOperations.get(client)
    ) {
      await this.closeClientWhenIdle(client);
    }

    this.activeClientOperations.set(
      client,
      (this.activeClientOperations.get(client) ?? 0) + 1
    );

    try {
      return await operation(client, account.index);
    } finally {
      const remaining = (this.activeClientOperations.get(client) ?? 1) - 1;
      if (remaining > 0) {
        this.activeClientOperations.set(client, remaining);
      } else {
        this.activeClientOperations.delete(client);
        if (this.pendingClientCloses.has(client)) {
          await this.closeClientWhenIdle(client);
        }
      }
    }
  }

  async closeClientWhenIdle(client) {
    this.pendingClientCloses.add(client);
    if ((this.activeClientOperations.get(client) ?? 0) > 0) {
      return;
    }

    const existingPromise = this.clientClosePromises.get(client);
    if (existingPromise) {
      return existingPromise;
    }

    const closePromise = Promise.resolve()
      .then(() => client.close?.())
      .catch((error) => {
        console.warn(`Failed to close a Grok account client: ${error.message}`);
      })
      .finally(() => {
        this.pendingClientCloses.delete(client);
        this.clientClosePromises.delete(client);
      });

    this.clientClosePromises.set(client, closePromise);
    return closePromise;
  }

  async closeAccountsWhenIdle(accounts) {
    await Promise.all(
      accounts.map((account) => this.closeClientWhenIdle(account.client))
    );
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
        value: await this.runAccountOperation(account, operation)
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
            value: await this.runAccountOperation(primaryAccount, operation)
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
            value: await this.runAccountOperation(primaryAccount, operation)
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
          value: await this.runAccountOperation(fallbackAccount, operation)
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

  async close({ force = false } = {}) {
    this.closed = true;
    await this.accountsPromise?.catch(() => {});

    if (force) {
      await Promise.allSettled(
        Array.from(this.knownClients, (client) => {
          const existingPromise = this.clientClosePromises.get(client);
          return existingPromise ?? client.close?.();
        })
      );
      this.pendingClientCloses.clear();
      this.clientClosePromises.clear();
      return;
    }

    await Promise.all(
      Array.from(this.knownClients, (client) => this.closeClientWhenIdle(client))
    );
    await Promise.all(this.clientClosePromises.values());
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
      await this.closeClientWhenIdle(previousActiveAccount.client);
    }
  }

  async handleFailure(account, accounts, error = null) {
    if (this.isSessionUnavailableError(error)) {
      this.unavailableAccountIndexes.add(account.index);
      this.unavailableAccountTimestamps.set(account.index, Date.now());
      await this.closeClientWhenIdle(account.client);

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

    await this.closeClientWhenIdle(account.client);

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
