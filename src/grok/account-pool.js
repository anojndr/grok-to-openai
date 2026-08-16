import path from "node:path";
import fs from "node:fs/promises";
import { parseCookieSets } from "../lib/cookies.js";
import { HttpError } from "../lib/errors.js";
import { GrokClient } from "./client.js";
import {
  GROK_SESSION_BLOCKED_ERROR_CODE,
  GROK_REQUEST_TIMEOUT_ERROR_CODE
} from "./browser-session.js";

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
    this.unavailableAccountCooldowns = new Map();
    this.lastLoadedContent = null;
    this.lastReloadWarning = null;
    this.loadedAccounts = null;
    this.activeClientOperations = new Map();
    this.pendingClientCloses = new Set();
    this.clientClosePromises = new Map();
    this.knownClients = new Set();
    this.warmBackupIndex = null;
    this.initializedClients = new WeakSet();
    this.clientInitPromises = new Map();
    this.closed = false;
  }

  isAccountUnavailable(index, cooldownMs = null) {
    if (!this.unavailableAccountIndexes.has(index)) {
      return false;
    }
    const timestamp = this.unavailableAccountTimestamps.get(index);
    // Rate-limit (429) quarantines use a short cooldown so the pool
    // self-heals quickly when Grok's throttling window passes; hard
    // failures (session blocked, expired auth) keep the full 15 minutes.
    const effectiveCooldownMs =
      cooldownMs ??
      this.unavailableAccountCooldowns.get(index) ??
      this.config.rateLimitCooldownMs ??
      15 * 60 * 1000;
    if (timestamp && Date.now() - timestamp > effectiveCooldownMs) {
      this.unavailableAccountIndexes.delete(index);
      // unavailableAccountTimestamps and unavailableAccountCooldowns survive
      // the purge as throttle history: a post-expiry retry that trips the
      // limiter again escalates via handleFailure; only a successful
      // operation resets the history.
      return false;
    }
    return true;
  }

  // Cooldown ladder for recurring rate limits: each time an account is
  // retried after its cooldown expired and trips the limiter again, wait
  // longer. Starts at the configured base and caps at 60 minutes so a
  // saturated pool never loops on short cooldowns, while a single 429 still
  // recovers quickly.
  rateLimitCooldownForRetries(retries = 0) {
    const baseCooldownMs = this.config.rateLimitCooldownMs ?? 2 * 60 * 1000;
    if (retries <= 0) {
      return baseCooldownMs;
    }

    const ladder = [
      5 * 60 * 1000,
      15 * 60 * 1000,
      30 * 60 * 1000,
      60 * 60 * 1000
    ];
    const escalated = ladder[Math.min(retries - 1, ladder.length - 1)];

    return Math.max(baseCooldownMs, escalated);
  }

  // Number of rate-limit recurrences encoded by a surviving cooldown record:
  // base (no history) -> 1 recurrence, 5min -> 2, 15min -> 3, 30min+ -> cap.
  rateLimitRecurrenceCount(previousCooldownMs) {
    const baseCooldownMs = this.config.rateLimitCooldownMs ?? 2 * 60 * 1000;
    const ladder = [
      baseCooldownMs,
      5 * 60 * 1000,
      15 * 60 * 1000,
      30 * 60 * 1000,
      60 * 60 * 1000
    ];
    const position = ladder.indexOf(previousCooldownMs);
    return position >= 0 ? position + 1 : 1;
  }

  checkPoolExhaustion(accounts) {
    if (!accounts || accounts.length === 0) {
      return false;
    }
    // Purging expired cooldowns is what lets the pool recover over time;
    // do NOT clear the whole quarantine set here. Clearing it the moment
    // every account is unavailable made each queued request re-try EVERY
    // account (each 429-ing again) for minutes — a retry storm that turned
    // an all-exhausted pool into a multi-minute stall instead of a fast 503.
    for (const index of Array.from(this.unavailableAccountIndexes)) {
      this.isAccountUnavailable(index);
    }
    return this.unavailableAccountIndexes.size >= accounts.length;
  }

  async ensureClientInitialized(account, { foreground = false } = {}) {
    const client = account.client;
    if (this.initializedClients.has(client)) {
      return;
    }

    const existingPromise = this.clientInitPromises.get(client);
    if (existingPromise) {
      if (foreground) {
        await existingPromise;
      }
      return;
    }

    const initPromise = Promise.resolve()
      .then(() => client.init?.())
      .catch((error) => {
        this.initializedClients.delete(client);
        console.warn(`Failed to initialize account ${account.index}: ${error.message}`);
        throw error;
      })
      .finally(() => {
        if (this.clientInitPromises.get(client) === initPromise) {
          this.clientInitPromises.delete(client);
        }
      });

    this.clientInitPromises.set(client, initPromise);
    this.initializedClients.add(client);

    if (foreground) {
      try {
        await initPromise;
        this.initializedClients.add(client);
      } catch (error) {
        this.initializedClients.delete(client);
        throw error;
      }
    } else {
      initPromise.catch(() => {});
    }
  }

  async init() {
    const accounts = await this.getAccounts();
    if (!accounts || !accounts.length) {
      return;
    }

    let primaryAccount = this.getPrimaryAccount(accounts);
    if (primaryAccount) {
      try {
        await this.runAccountOperation(primaryAccount, () =>
          this.ensureClientInitialized(primaryAccount, { foreground: true }));
        // Keep one backup account warm in the background so the first request
        // after a primary failure never pays a cold browser start.
        void this.syncBackupWarm(accounts);
        return;
      } catch (error) {
        console.warn(`Primary Grok account failed to initialize on boot: ${error.message}`);
        await this.handleFailure(primaryAccount, accounts, error);
      }
    }

    const fallbackAccounts = this.getFallbackAccounts(accounts);
    for (const fallbackAccount of fallbackAccounts) {
      try {
        await this.runAccountOperation(fallbackAccount, () =>
          this.ensureClientInitialized(fallbackAccount, { foreground: true }));
        await this.activateFallbackAccount(fallbackAccount, accounts);
        break;
      } catch (error) {
        console.warn(`Fallback Grok account ${fallbackAccount.index} failed to initialize on boot: ${error.message}`);
        await this.handleFailure(fallbackAccount, accounts, error);
      }
    }

    // Keep one backup account warm in the background so the first request
    // after a primary failure never pays a cold browser start.
    void this.syncBackupWarm(accounts);
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
    this.unavailableAccountCooldowns.clear();
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
      const value = await operation(client, account.index);
      // A successful operation proves the upstream limiter window has passed;
      // reset the rate-limit escalation history for this account.
      this.unavailableAccountTimestamps.delete(account.index);
      this.unavailableAccountCooldowns.delete(account.index);
      return value;
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

  async withAccount(accountIndex, operation, options = {}) {
    const fallback = options.fallback ?? true;
    const accounts = await this.getAccounts();
    this.checkPoolExhaustion(accounts);

    const normalizedIndex = Number.isInteger(accountIndex) ? accountIndex : 0;
    const account = accounts[normalizedIndex];

    if (!account) {
      throw new Error(`Unknown Grok account index: ${accountIndex}`);
    }

    if (this.isAccountUnavailable(account.index)) {
      if (!fallback) {
        throw new HttpError(
          503,
          `Grok account ${account.index} is temporarily unavailable`
        );
      }
      return this.withFallback(operation, options);
    }

    try {
      const result = {
        accountIndex: account.index,
        value: await this.runAccountOperation(account, operation)
      };

      await this.activateFallbackAccount(account, accounts);
      return result;
    } catch (error) {
      await this.handleFailure(account, accounts, error);

      if (fallback && this.isSessionUnavailableError(error)) {
        return this.withFallback(operation, options);
      }

      throw error;
    }
  }

  async withFallback(operation, options = {}) {
    const accounts = await this.getAccounts();
    if (this.checkPoolExhaustion(accounts)) {
      // Every account is quarantined. Fail fast with 503 instead of walking
      // the whole pool again: cooldowns expire by themselves, so the next
      // request naturally recovers. (Without this, each request re-tried all
      // accounts for minutes whenever they were all rate-limited.)
      throw new HttpError(
        503,
        "All Grok accounts are temporarily unavailable",
        { code: "pool_exhausted" }
      );
    }

    let primaryAccount = this.getPrimaryAccount(accounts);

    if (!primaryAccount && !this.getFallbackAccounts(accounts).length) {
      throw new Error("No Grok accounts configured");
    }

    let fallbackAccounts = this.getFallbackAccounts(accounts);
    const deadlineMs = Number(this.config.fallbackMaxTotalMs) || 0;
    let sweepStartedAt = Date.now();
    const throwIfSweepDeadlinePassed = (error) => {
      // A failing sweep should not stall the client for minutes while it walks
      // every account. Once the total fallback deadline has elapsed on a
      // session-unavailable failure, surface the error right away; the failed
      // account is already quarantined, so the next request skips it.
      if (
        deadlineMs > 0 &&
        Date.now() - sweepStartedAt >= deadlineMs &&
        this.isSessionUnavailableError(error)
      ) {
        throw error;
      }
    };

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
          throwIfSweepDeadlinePassed(error);
        }
      }

      throw lastError ?? new Error("No Grok accounts configured");
    }

    let lastError = null;
    let exhaustedPasses = 0;
    let consecutiveRateLimitFailures = 0;

    while (exhaustedPasses < 2) {
      primaryAccount = this.getPrimaryAccount(accounts);
      if (primaryAccount) {
        const attemptStartedAt = Date.now();
        try {
          await this.runAccountOperation(primaryAccount, () =>
            this.ensureClientInitialized(primaryAccount, { foreground: true }));
          return {
            accountIndex: primaryAccount.index,
            value: await this.runAccountOperation(primaryAccount, operation)
          };
        } catch (error) {
          lastError = error;
          console.warn(
            `[fallback] account ${primaryAccount.index} failed after ${Date.now() - attemptStartedAt} ms: ${error.message}`
          );
          await this.handleFailure(primaryAccount, accounts, error);
          consecutiveRateLimitFailures = this.isRateLimitError(error)
            ? consecutiveRateLimitFailures + 1
            : 0;
          // The fallback walk gets its own deadline: the primary attempt may
          // have consumed the whole sweep budget (e.g. a long page hang),
          // which would otherwise starve every fallback of a chance.
          sweepStartedAt = Date.now();
        }
      }

      fallbackAccounts = this.getFallbackAccounts(accounts);
      if (!fallbackAccounts.length) {
        break;
      }

      const fallbackAccount = this.getActiveFallbackAccount(fallbackAccounts);
      const attemptStartedAt = Date.now();

      try {
        await this.runAccountOperation(fallbackAccount, () =>
          this.ensureClientInitialized(fallbackAccount, { foreground: true }));
        return {
          accountIndex: fallbackAccount.index,
          value: await this.runAccountOperation(fallbackAccount, operation)
        };
      } catch (error) {
        lastError = error;
        console.warn(
          `[fallback] account ${fallbackAccount.index} failed after ${Date.now() - attemptStartedAt} ms: ${error.message}`
        );
        const failure = await this.handleFailure(fallbackAccount, accounts, error);
        consecutiveRateLimitFailures = this.isRateLimitError(error)
          ? consecutiveRateLimitFailures + 1
          : 0;
        // If three different accounts in a row were all rate-limited, the
        // whole pool is throttled right now; walking the rest just burns
        // time and trips our own request deadline. Surface the error now.
        if (consecutiveRateLimitFailures >= 3) {
          throw error;
        }
        throwIfSweepDeadlinePassed(error);
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

  async syncBackupWarm(accounts) {
    if (this.closed) {
      return;
    }

    // Warming a backup requires a second account; with a single account this
    // would also trip checkPoolExhaustion's all-unavailable reset and clear
    // a fresh quarantine, so bail before touching the pool status.
    if (!accounts || accounts.length < 2) {
      this.warmBackupIndex = null;
      return;
    }

    const fallbackAccounts = this.getFallbackAccounts(accounts);
    if (!fallbackAccounts.length) {
      this.warmBackupIndex = null;
      return;
    }

    const target = this.getActiveFallbackAccount(fallbackAccounts);

    // A cold backup costs ~20-30 s (browser launch + page mount + statsig
    // discovery) on first use. Keep exactly one backup account warm in the
    // background so fallback requests stay fast without holding one Chrome
    // per account (memory bound). The previously warmed backup is already
    // closed by handleFailure/activateFallbackAccount when the active
    // fallback changes, so we only update the target here.
    if (this.warmBackupIndex === target.index) {
      return;
    }

    this.warmBackupIndex = target.index;
    void this.runAccountOperation(target, () =>
      this.ensureClientInitialized(target, { foreground: true }))
      .catch((error) => {
        if (this.warmBackupIndex === target.index) {
          this.warmBackupIndex = null;
        }
        console.warn(
          `[warm] backup account ${target.index} failed to initialize: ${error.message}`
        );
        return this.handleFailure(target, accounts, error);
      });
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
      // Capture pre-mutation state: the expiry purge below (and the refresh
      // after it) must not erase the history this function escalates on.
      const previousCooldownMs = this.unavailableAccountCooldowns.get(
        account.index
      );
      const previousTimestamp = this.unavailableAccountTimestamps.get(
        account.index
      );
      const previousElapsed =
        previousCooldownMs != null &&
        previousTimestamp != null &&
        Date.now() - previousTimestamp > previousCooldownMs;

      // Purge a stale quarantine first so the cooldown history below reflects
      // post-expiry state; the cooldown record deliberately survives the purge.
      this.isAccountUnavailable(account.index);
      this.unavailableAccountIndexes.add(account.index);
      this.unavailableAccountTimestamps.set(account.index, Date.now());
      if (this.isRateLimitError(error)) {
        // Grok rate limits reset much faster than auth/session failures; use a
        // short cooldown for 429s so the pool self-heals instead of taking a
        // full 15-minute outage whenever every account is throttled.
        // unavailableAccountCooldowns survives the expiry purge (see
        // isAccountUnavailable). If a previous cooldown has already elapsed
        // and the limiter trips again, the upstream window outlasted it:
        // escalate instead of looping at the base.
        const retries = previousElapsed
          ? this.rateLimitRecurrenceCount(previousCooldownMs)
          : 0;
        this.unavailableAccountCooldowns.set(
          account.index,
          this.rateLimitCooldownForRetries(retries)
        );
      } else {
        // Hard failures (session blocks, auth expiry) always get the full
        // 15-minute cooldown regardless of any rate-limit history.
        this.unavailableAccountCooldowns.set(account.index, 15 * 60 * 1000);
      }
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
    void this.syncBackupWarm(accounts);
    return { wrapped: nextPosition === 0 };
  }

  isRateLimitError(error) {
    return (
      error?.status === 429 ||
      error?.statusCode === 429 ||
      /\btoo many requests\b|\brate limit\b|\brate_limit\b|\bexceeded limit\b/i.test(
        String(error?.message ?? "")
      )
    );
  }

  isSessionUnavailableError(error) {
    if (!error) {
      return false;
    }

    if (
      error.details?.code === GROK_SESSION_BLOCKED_ERROR_CODE ||
      error.details?.code === GROK_REQUEST_TIMEOUT_ERROR_CODE ||
      error.details?.code === "statsig_unavailable" ||
      error.code === GROK_REQUEST_TIMEOUT_ERROR_CODE ||
      error.code === "ETIMEDOUT" ||
      error.code === "ECONNRESET" ||
      error.code === "ECONNREFUSED"
    ) {
      return true;
    }

    if (
      error.status === 401 ||
      error.status === 403 ||
      error.status === 429 ||
      error.status === 503 ||
      error.status === 504 ||
      error.statusCode === 401 ||
      error.statusCode === 403 ||
      error.statusCode === 429 ||
      error.statusCode === 503 ||
      error.statusCode === 504
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
      message.includes("504") ||
      message.includes("timed out") ||
      message.includes("timeout") ||
      message.includes("target page, context or browser has been closed") ||
      message.includes("target closed") ||
      message.includes("browser has been closed") ||
      message.includes("connection closed") ||
      message.includes("could not load statsig middleware") ||
      message.includes("could not find statsig module") ||
      message.includes("statsig id generation failed") ||
      message.includes("statsig_unavailable") ||
      message.includes("ended the stream before the final assistant response") ||
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("etimedout") ||
      message.includes("redirected to login page") ||
      message.includes("grok session is blocked or not authenticated")
    ) {
      return true;
    }

    return false;
  }
}
