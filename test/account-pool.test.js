import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GrokAccountPool } from "../src/grok/account-pool.js";
import { HttpError } from "../src/lib/errors.js";
import {
  GROK_SESSION_BLOCKED_ERROR_CODE,
  GROK_REQUEST_TIMEOUT_ERROR_CODE
} from "../src/grok/browser-session.js";

function createMockAccount(name, outcomes) {
  let closeCalls = 0;
  let runCalls = 0;

  return {
    name,
    get closeCalls() {
      return closeCalls;
    },
    get runCalls() {
      return runCalls;
    },
    async run() {
      runCalls += 1;
      const outcome = outcomes.shift();

      if (outcome instanceof Error) {
        throw outcome;
      }

      return outcome;
    },
    async close() {
      closeCalls += 1;
    }
  };
}

function cookieFileText(...accountNames) {
  return accountNames
    .map(
      (accountName) => `# Netscape HTTP Cookie File\n.grok.com\tTRUE\t/\tTRUE\t1790626586\tsso\t${accountName}`
    )
    .join("\n\n");
}

function createTrackedClient(config) {
  let closeCalls = 0;

  return {
    config,
    get closeCalls() {
      return closeCalls;
    },
    async close() {
      closeCalls += 1;
    }
  };
}

test(
  "withFallback retries the primary account before each fallback, closes failed fallback clients, and reuses the active fallback",
  async () => {
    const calls = [];
    const accounts = [
      createMockAccount("primary", [
        new Error("primary-1"),
        new Error("primary-2"),
        new Error("primary-3")
      ]),
      createMockAccount("secondary", [new Error("secondary-1")]),
      createMockAccount("tertiary", ["tertiary-ok", "tertiary-ok-again"]),
      createMockAccount("quaternary", ["unused"])
    ];
    const pool = new GrokAccountPool({}, { accounts });

    const firstResult = await pool.withFallback(async (client) => {
      calls.push(client.name);
      return client.run();
    });

    const secondResult = await pool.withFallback(async (client) => {
      calls.push(client.name);
      return client.run();
    });

    assert.deepEqual(calls, [
      "primary",
      "secondary",
      "primary",
      "tertiary",
      "primary",
      "tertiary"
    ]);
    assert.deepEqual(firstResult, {
      accountIndex: 2,
      value: "tertiary-ok"
    });
    assert.deepEqual(secondResult, {
      accountIndex: 2,
      value: "tertiary-ok-again"
    });
    assert.equal(accounts[0].closeCalls, 0);
    assert.equal(accounts[1].closeCalls, 1);
    assert.equal(accounts[2].closeCalls, 0);
    assert.equal(accounts[3].closeCalls, 0);
  }
);

test(
  "withFallback stops the sweep once the total fallback deadline is exceeded on session-unavailable failures",
  async () => {
    const timeoutError = new HttpError(504, "Grok request timed out after 600000 ms", {
      code: GROK_REQUEST_TIMEOUT_ERROR_CODE
    });
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const createSlowMockAccount = (name) => {
      let runCalls = 0;
      return {
        name,
        get runCalls() {
          return runCalls;
        },
        async run() {
          runCalls += 1;
          await sleep(30);
          throw timeoutError;
        },
        async close() {}
      };
    };
    const calls = [];
    const accounts = [
      createSlowMockAccount("primary"),
      createSlowMockAccount("secondary"),
      createSlowMockAccount("tertiary")
    ];
    const pool = new GrokAccountPool({ fallbackMaxTotalMs: 5 }, { accounts });

    await assert.rejects(
      pool.withFallback(async (client) => {
        calls.push(client.name);
        return client.run();
      }),
      (err) => err.status === 504
    );

    // The deadline must stop the sweep right after the first failed account
    // instead of walking the whole pool for minutes.
    assert.ok(
      calls.length < 3,
      `expected sweep to stop early, tried: ${calls.join(",")}`
    );
  }
);

test(
  "withFallback resets the sweep deadline after a slow primary failure so fallbacks are still tried",
  async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const primary = {
      name: "primary",
      async run() {
        await sleep(60);
        throw new HttpError(504, "Grok request timed out after 600000 ms", {
          code: GROK_REQUEST_TIMEOUT_ERROR_CODE
        });
      },
      async close() {}
    };
    const secondary = {
      name: "secondary",
      async run() {
        return "secondary-ok";
      },
      async close() {}
    };

    const calls = [];
    const pool = new GrokAccountPool(
      { fallbackMaxTotalMs: 5 },
      { accounts: [primary, secondary] }
    );

    const result = await pool.withFallback(async (client) => {
      calls.push(client.name);
      return client.run();
    });

    // A 60 ms primary hang exceeds the 5 ms sweep deadline, but the deadline
    // must not starve the fallback: the sweep clock resets once the primary
    // attempt is over, so the backup account still gets a chance.
    assert.equal(result.accountIndex, 1);
    assert.equal(result.value, "secondary-ok");
    assert.deepEqual(calls, ["primary", "secondary"]);
  }
);

test("withFallback quarantines an account whose statsig id generation failed", async () => {
  const statsigError = new Error(
    "Grok statsig id generation failed: Cannot read properties of undefined (reading 'childNodes')"
  );
  const accounts = [
    createMockAccount("primary", [statsigError, statsigError])
  ];
  const pool = new GrokAccountPool({}, { accounts });

  await assert.rejects(pool.withFallback(async (client) => client.run()));

  assert.equal(pool.isAccountUnavailable(0), true);
});

test(
  "withFallback restarts from the secondary account after the last fallback fails and raises after two exhausted passes",
  async () => {
    const calls = [];
    const accounts = [
      createMockAccount("primary", [
        new Error("primary-a"),
        new Error("primary-b"),
        new Error("primary-c"),
        new Error("primary-d"),
        new Error("primary-e"),
        new Error("primary-f")
      ]),
      createMockAccount("secondary", [
        new Error("secondary-a"),
        new Error("secondary-b")
      ]),
      createMockAccount("tertiary", [
        new Error("tertiary-a"),
        new Error("tertiary-b")
      ]),
      createMockAccount("quaternary", [
        new Error("quaternary-a"),
        new Error("quaternary-b")
      ])
    ];
    const pool = new GrokAccountPool({}, { accounts });

    await assert.rejects(
      pool.withFallback(async (client) => {
        calls.push(client.name);
        return client.run();
      }),
      /quaternary-b/
    );

    assert.deepEqual(calls, [
      "primary",
      "secondary",
      "primary",
      "tertiary",
      "primary",
      "quaternary",
      "primary",
      "secondary",
      "primary",
      "tertiary",
      "primary",
      "quaternary"
    ]);
    assert.equal(accounts[0].closeCalls, 0);
    assert.equal(accounts[1].closeCalls, 2);
    assert.equal(accounts[2].closeCalls, 2);
    assert.equal(accounts[3].closeCalls, 2);
  }
);

test(
  "withAccount promotes a successful fallback account to active fallback and closes the previously active fallback client",
  async () => {
    const calls = [];
    const accounts = [
      createMockAccount("primary", [
        new Error("primary-1"),
        new Error("primary-2"),
        new Error("primary-3")
      ]),
      createMockAccount("secondary", [
        new Error("secondary-1"),
        "secondary-ok",
        "secondary-ok-again"
      ]),
      createMockAccount("tertiary", ["tertiary-ok"]),
      createMockAccount("quaternary", ["unused"])
    ];
    const pool = new GrokAccountPool({}, { accounts });

    const fallbackResult = await pool.withFallback(async (client) => {
      calls.push(client.name);
      return client.run();
    });

    const directResult = await pool.withAccount(1, async (client) => {
      calls.push(client.name);
      return client.run();
    });

    const nextFallbackResult = await pool.withFallback(async (client) => {
      calls.push(client.name);
      return client.run();
    });

    assert.deepEqual(calls, [
      "primary",
      "secondary",
      "primary",
      "tertiary",
      "secondary",
      "primary",
      "secondary"
    ]);
    assert.deepEqual(fallbackResult, {
      accountIndex: 2,
      value: "tertiary-ok"
    });
    assert.deepEqual(directResult, {
      accountIndex: 1,
      value: "secondary-ok"
    });
    assert.deepEqual(nextFallbackResult, {
      accountIndex: 1,
      value: "secondary-ok-again"
    });
    assert.equal(accounts[1].closeCalls, 1);
    assert.equal(accounts[2].closeCalls, 1);
  }
);

test("withAccount falls back when the requested account is Cloudflare-blocked", async () => {
  const calls = [];
  const sessionBlockedError = new HttpError(502, "blocked", {
    code: GROK_SESSION_BLOCKED_ERROR_CODE
  });
  const accounts = [
    createMockAccount("primary", ["primary-ok", "primary-ok-again"]),
    createMockAccount("secondary", [sessionBlockedError]),
    createMockAccount("tertiary", ["unused"])
  ];
  const pool = new GrokAccountPool({}, { accounts });

  const result = await pool.withAccount(1, async (client) => {
    calls.push(client.name);
    return client.run();
  });

  assert.deepEqual(calls, ["secondary", "primary"]);
  assert.deepEqual(result, {
    accountIndex: 0,
    value: "primary-ok"
  });
  assert.equal(accounts[1].closeCalls, 1);

  const secondResult = await pool.withAccount(1, async (client) => {
    calls.push(client.name);
    return client.run();
  });

  assert.deepEqual(calls, ["secondary", "primary", "primary"]);
  assert.deepEqual(secondResult, {
    accountIndex: 0,
    value: "primary-ok-again"
  });
  assert.equal(accounts[1].runCalls, 1);
});

test("withAccount with fallback: false throws immediately when the account is Cloudflare-blocked without trying other accounts", async () => {
  const calls = [];
  const sessionBlockedError = new HttpError(502, "blocked", {
    code: GROK_SESSION_BLOCKED_ERROR_CODE
  });
  const accounts = [
    createMockAccount("primary", ["primary-ok"]),
    createMockAccount("secondary", [sessionBlockedError]),
    createMockAccount("tertiary", ["unused"])
  ];
  const pool = new GrokAccountPool({}, { accounts });

  await assert.rejects(
    pool.withAccount(
      1,
      async (client) => {
        calls.push(client.name);
        return client.run();
      },
      { fallback: false }
    ),
    (err) => err?.details?.code === GROK_SESSION_BLOCKED_ERROR_CODE
  );

  assert.deepEqual(calls, ["secondary"]);
  assert.equal(accounts[1].closeCalls, 1);
  assert.equal(pool.isAccountUnavailable(1), true);

  // Subsequent call with fallback: false on quarantined account should throw without running anything
  await assert.rejects(
    pool.withAccount(
      1,
      async (client) => {
        calls.push(client.name);
        return client.run();
      },
      { fallback: false }
    ),
    /unavailable/i
  );

  assert.deepEqual(calls, ["secondary"]);
});


test("withFallback quarantines Cloudflare-blocked accounts and skips them on later attempts", async () => {
  const calls = [];
  const sessionBlockedError = new HttpError(502, "blocked", {
    code: GROK_SESSION_BLOCKED_ERROR_CODE
  });
  const accounts = [
    createMockAccount("primary", [
      sessionBlockedError,
      "primary-should-not-run"
    ]),
    createMockAccount("secondary", [
      sessionBlockedError,
      "secondary-should-not-run"
    ]),
    createMockAccount("tertiary", ["tertiary-ok", "tertiary-ok-again"])
  ];
  const pool = new GrokAccountPool({}, { accounts });

  const firstResult = await pool.withFallback(async (client) => {
    calls.push(client.name);
    return client.run();
  });
  const secondResult = await pool.withFallback(async (client) => {
    calls.push(client.name);
    return client.run();
  });

  assert.deepEqual(calls, [
    "primary",
    "secondary",
    "tertiary",
    "tertiary"
  ]);
  assert.deepEqual(firstResult, {
    accountIndex: 2,
    value: "tertiary-ok"
  });
  assert.deepEqual(secondResult, {
    accountIndex: 2,
    value: "tertiary-ok-again"
  });
  assert.equal(accounts[0].closeCalls, 1);
  assert.equal(accounts[1].closeCalls, 1);
});

test("getAccounts splits multi-account cookie text into isolated account configs", async () => {
  const clientConfigs = [];
  const pool = new GrokAccountPool(
    {
      browserProfileDir: "/tmp/grok-profile",
      grokCookiesText: `
# Netscape HTTP Cookie File
.grok.com\tTRUE\t/\tTRUE\t1790626586\tsso\taccount-1

# Netscape HTTP Cookie File
.grok.com\tTRUE\t/\tTRUE\t1790626586\tsso\taccount-2
`
    },
    {
      clientFactory(accountConfig) {
        clientConfigs.push(accountConfig);
        return {
          async close() {}
        };
      }
    }
  );

  const accounts = await pool.getAccounts();

  assert.equal(accounts.length, 2);
  assert.equal(clientConfigs.length, 2);
  assert.equal(clientConfigs[0].grokCookies[0].value, "account-1");
  assert.equal(clientConfigs[1].grokCookies[0].value, "account-2");
  assert.equal(
    clientConfigs[0].browserProfileDir,
    "/tmp/grok-profile/account-001"
  );
  assert.equal(
    clientConfigs[1].browserProfileDir,
    "/tmp/grok-profile/account-002"
  );
});

test("getAccounts hot-reloads changed cookie files exactly once", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "grok-account-pool-"));
  const cookieFile = path.join(dataDir, "cookies.txt");
  const clients = [];
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await fs.writeFile(cookieFile, cookieFileText("account-1"));
  const pool = new GrokAccountPool(
    {
      browserProfileDir: path.join(dataDir, "profile"),
      grokCookieFile: cookieFile,
      grokCookiesText: ""
    },
    {
      clientFactory(config) {
        const client = createTrackedClient(config);
        clients.push(client);
        return client;
      }
    }
  );

  const firstAccounts = await pool.getAccounts();
  assert.equal(firstAccounts.length, 1);
  assert.equal(clients.length, 1);

  await fs.writeFile(cookieFile, cookieFileText("account-2", "account-3"));
  const reloads = await Promise.all([
    pool.getAccounts(),
    pool.getAccounts(),
    pool.getAccounts()
  ]);

  assert.equal(reloads[0], reloads[1]);
  assert.equal(reloads[1], reloads[2]);
  assert.equal(reloads[0].length, 2);
  assert.equal(clients.length, 3);
  assert.equal(clients[1].config.grokCookies[0].value, "account-2");
  assert.equal(clients[2].config.grokCookies[0].value, "account-3");

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clients[0].closeCalls, 1);
  await pool.close();
});

test("getAccounts retains the last known-good pool for malformed reloads", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "grok-account-pool-"));
  const cookieFile = path.join(dataDir, "cookies.txt");
  const clients = [];
  const warnings = [];
  const originalWarn = console.warn;
  t.after(async () => {
    console.warn = originalWarn;
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  console.warn = (message) => warnings.push(String(message));

  await fs.writeFile(cookieFile, cookieFileText("account-1"));
  const pool = new GrokAccountPool(
    {
      grokCookieFile: cookieFile,
      grokCookiesText: ""
    },
    {
      clientFactory(config) {
        const client = createTrackedClient(config);
        clients.push(client);
        return client;
      }
    }
  );

  const firstAccounts = await pool.getAccounts();
  await fs.writeFile(cookieFile, '[{"name":"sso"');
  const retainedAccounts = await pool.getAccounts();

  assert.equal(retainedAccounts, firstAccounts);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].closeCalls, 0);
  assert.match(warnings[0], /last known-good account pool/);
  await pool.close();
});

test("hot reload waits for in-flight account work before closing its client", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "grok-account-pool-"));
  const cookieFile = path.join(dataDir, "cookies.txt");
  const clients = [];
  let releaseOperation;
  let markStarted;
  const operationStarted = new Promise((resolve) => {
    markStarted = resolve;
  });
  const operationGate = new Promise((resolve) => {
    releaseOperation = resolve;
  });
  t.after(async () => {
    releaseOperation?.();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await fs.writeFile(cookieFile, cookieFileText("account-1"));
  const pool = new GrokAccountPool(
    {
      grokCookieFile: cookieFile,
      grokCookiesText: ""
    },
    {
      clientFactory(config) {
        const client = createTrackedClient(config);
        clients.push(client);
        return client;
      }
    }
  );

  const operation = pool.withFallback(async () => {
    markStarted();
    await operationGate;
    return "ok";
  });
  await operationStarted;

  await fs.writeFile(cookieFile, cookieFileText("account-2"));
  await pool.getAccounts();
  assert.equal(clients[0].closeCalls, 0);

  releaseOperation();
  assert.equal((await operation).value, "ok");
  assert.equal(clients[0].closeCalls, 1);
  await pool.close();
});

test("cooldown automatically removes unavailable status after cooldown period", async () => {
  const accounts = [
    createMockAccount("primary", ["primary-ok"]),
    createMockAccount("secondary", ["unused"])
  ];
  const pool = new GrokAccountPool({}, { accounts });
  
  // Mark primary as unavailable
  pool.unavailableAccountIndexes.add(0);
  pool.unavailableAccountTimestamps.set(0, Date.now() - 1000); // 1 sec ago
  
  // Cooldown is set to 500ms, so it should be considered available again
  assert.equal(pool.isAccountUnavailable(0, 500), false);
  assert.equal(pool.unavailableAccountIndexes.has(0), false);
});

test("withFallback rotates on 429 rate limit error", async () => {
  const rateLimitError = new HttpError(429, "Too Many Requests");
  const accounts = [
    createMockAccount("primary", [rateLimitError]),
    createMockAccount("secondary", ["secondary-ok"])
  ];
  const pool = new GrokAccountPool({}, { accounts });

  const result = await pool.withFallback(async (client) => {
    return client.run();
  });

  assert.deepEqual(result, {
    accountIndex: 1,
    value: "secondary-ok"
  });
  assert.ok(pool.unavailableAccountIndexes.has(0));
});

test("withFallback rotates on heavy usage error", async () => {
  const heavyUsageError = new HttpError(502, "Grok is under heavy usage right now. Please try again later, use a different model or upgrade plan for higher limits.");
  const accounts = [
    createMockAccount("primary", [heavyUsageError]),
    createMockAccount("secondary", ["secondary-ok"])
  ];
  const pool = new GrokAccountPool({}, { accounts });

  const result = await pool.withFallback(async (client) => {
    return client.run();
  });

  assert.deepEqual(result, {
    accountIndex: 1,
    value: "secondary-ok"
  });
  assert.ok(pool.unavailableAccountIndexes.has(0));
});

test("withFallback fails fast when all accounts are unavailable instead of storming the pool", async () => {
  const rateLimitError = new HttpError(429, "Too Many Requests");
  const accounts = [
    createMockAccount("primary", [rateLimitError, "primary-recovered"]),
    createMockAccount("secondary", [rateLimitError, "secondary-recovered"])
  ];
  const pool = new GrokAccountPool({}, { accounts });

  // First request exhausts both accounts (429 -> quarantine -> sweep).
  await assert.rejects(
    pool.withFallback(async (client) => client.run()),
    /Too Many Requests/
  );

  // A second request with the whole pool quarantined must fail fast with 503
  // and NOT attempt any account again (previously this cleared every
  // quarantine and re-tried the whole pool for minutes).
  const calls = [];
  await assert.rejects(
    pool.withFallback(async (client) => {
      calls.push(client.name);
      return client.run();
    }),
    (error) => error?.status === 503 && error?.details?.code === "pool_exhausted"
  );

  assert.equal(calls.length, 0);
  // Cooldown is still intact (not cleared by exhaustion) so the pool recovers
  // on its own once the 15-minute cooldown elapses.
  assert.equal(pool.unavailableAccountIndexes.size, 2);
});

test("rate-limited accounts get a short cooldown while hard failures keep the long one", async () => {
  const rateLimitError = new HttpError(429, "Too Many Requests");
  const blockedError = new HttpError(502, "Grok session is blocked or not authenticated", {
    code: GROK_SESSION_BLOCKED_ERROR_CODE
  });
  const accounts = [
    {
      name: "secondary",
      index: 1,
      async run() {},
      async close() {}
    }
  ];
  const pool = new GrokAccountPool(
    { rateLimitCooldownMs: 2000 },
    { accounts: [createMockAccount("primary", []), ...accounts] }
  );

  // 429 -> short cooldown (2000ms).
  await pool.handleFailure({ index: 0, client: { close: async () => {} } }, pool.loadedAccounts, rateLimitError);
  assert.equal(pool.unavailableAccountCooldowns.get(0), 2000);

  // Hard session block -> full 15-minute cooldown.
  await pool.handleFailure({ index: 1, client: { close: async () => {} } }, pool.loadedAccounts, blockedError);
  assert.equal(pool.unavailableAccountCooldowns.get(1), 15 * 60 * 1000);

  // The 429 cooldown expires on its own (override 5000ms only affects the
  // explicit param; the stored 2000ms governs).
  pool.unavailableAccountTimestamps.set(0, Date.now() - 3000);
  assert.equal(pool.isAccountUnavailable(0), false);
  assert.equal(pool.isAccountUnavailable(1), true);
});

test("withFallback aborts after three consecutive 429s instead of walking the whole pool", async () => {
  const rateLimitError = new HttpError(429, "Too Many Requests");
  const accounts = [
    createMockAccount("primary", [rateLimitError, rateLimitError]),
    createMockAccount("secondary", [rateLimitError]),
    createMockAccount("tertiary", [rateLimitError]),
    createMockAccount("quaternary", ["should-not-run"])
  ];
  const pool = new GrokAccountPool({}, { accounts });

  const calls = [];
  await assert.rejects(
    pool.withFallback(async (client) => {
      calls.push(client.name);
      return client.run();
    }),
    /Too Many Requests/
  );

  // primary -> secondary -> tertiary are all 429; the sweep must stop after
  // three rate-limit failures without touching the fourth account.
  assert.deepEqual(calls, ["primary", "secondary", "tertiary"]);
});

test("withFallback rotates on 401 unauthenticated error", async () => {
  const authError = new HttpError(401, "Unauthorized");
  const accounts = [
    createMockAccount("primary", [authError]),
    createMockAccount("secondary", ["secondary-ok"])
  ];
  const pool = new GrokAccountPool({}, { accounts });

  const result = await pool.withFallback(async (client) => {
    return client.run();
  });

  assert.deepEqual(result, {
    accountIndex: 1,
    value: "secondary-ok"
  });
  assert.ok(pool.unavailableAccountIndexes.has(0));
});

test("withFallback rotates on 403 forbidden error", async () => {
  const forbiddenError = new HttpError(403, "Forbidden");
  const accounts = [
    createMockAccount("primary", [forbiddenError]),
    createMockAccount("secondary", ["secondary-ok"])
  ];
  const pool = new GrokAccountPool({}, { accounts });

  const result = await pool.withFallback(async (client) => {
    return client.run();
  });

  assert.deepEqual(result, {
    accountIndex: 1,
    value: "secondary-ok"
  });
  assert.ok(pool.unavailableAccountIndexes.has(0));
});

test("withFallback rotates on login redirect error message", async () => {
  const redirectError = new Error("redirected to login page (/login)");
  const accounts = [
    createMockAccount("primary", [redirectError]),
    createMockAccount("secondary", ["secondary-ok"])
  ];
  const pool = new GrokAccountPool({}, { accounts });

  const result = await pool.withFallback(async (client) => {
    return client.run();
  });

  assert.deepEqual(result, {
    accountIndex: 1,
    value: "secondary-ok"
  });
  assert.ok(pool.unavailableAccountIndexes.has(0));
});

test("withFallback rotates and quarantines on 504 request timeout error", async () => {
  const timeoutError = new HttpError(
    504,
    "Grok request timed out after 600000 ms",
    { code: GROK_REQUEST_TIMEOUT_ERROR_CODE }
  );
  const accounts = [
    createMockAccount("primary", [timeoutError]),
    createMockAccount("secondary", ["secondary-ok"])
  ];
  const pool = new GrokAccountPool({}, { accounts });

  const result = await pool.withFallback(async (client) => {
    return client.run();
  });

  assert.deepEqual(result, {
    accountIndex: 1,
    value: "secondary-ok"
  });
  assert.ok(pool.unavailableAccountIndexes.has(0));
});

test("withFallback rotates and quarantines on statsig or connection failure error", async () => {
  const connectionError = new Error("Connection closed while reading from the driver");
  const accounts = [
    createMockAccount("primary", [connectionError]),
    createMockAccount("secondary", ["secondary-ok"])
  ];
  const pool = new GrokAccountPool({}, { accounts });

  const result = await pool.withFallback(async (client) => {
    return client.run();
  });

  assert.deepEqual(result, {
    accountIndex: 1,
    value: "secondary-ok"
  });
  assert.ok(pool.unavailableAccountIndexes.has(0));
});

test("init pre-warms the first available fallback account when primary account fails on boot", async () => {
  const initCalls = [];
  const sessionBlockedError = new HttpError(502, "blocked", {
    code: GROK_SESSION_BLOCKED_ERROR_CODE
  });
  const accounts = [
    {
      name: "primary",
      async init() {
        initCalls.push("primary");
        throw sessionBlockedError;
      },
      async run() { return "primary"; },
      async close() {}
    },
    {
      name: "secondary",
      async init() {
        initCalls.push("secondary");
        return true;
      },
      async run() { return "secondary-ok"; },
      async close() {}
    },
    {
      name: "tertiary",
      async init() {
        initCalls.push("tertiary");
        return true;
      },
      async run() { return "tertiary"; },
      async close() {}
    }
  ];
  const pool = new GrokAccountPool({}, { accounts });

  await pool.init();

  assert.deepEqual(initCalls, ["primary", "secondary"]);
  assert.ok(pool.unavailableAccountIndexes.has(0));
  assert.equal(pool.activeFallbackAccountIndex, 1);
});

