import test from "node:test";
import assert from "node:assert/strict";
import { GrokAccountPool } from "../src/grok/account-pool.js";

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
