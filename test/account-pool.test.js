import test from "node:test";
import assert from "node:assert/strict";
import { GrokAccountPool } from "../src/grok/account-pool.js";

test("withFallback iterates accounts from top to bottom until one succeeds", async () => {
  const calls = [];
  const pool = new GrokAccountPool(
    {},
    {
      accounts: [
        {
          async run() {
            calls.push("account-0");
            throw new Error("rate limited");
          },
          async close() {}
        },
        {
          async run() {
            calls.push("account-1");
            return "ok";
          },
          async close() {}
        },
        {
          async run() {
            calls.push("account-2");
            return "unused";
          },
          async close() {}
        }
      ]
    }
  );

  const result = await pool.withFallback((client) => client.run());

  assert.deepEqual(calls, ["account-0", "account-1"]);
  assert.deepEqual(result, {
    accountIndex: 1,
    value: "ok"
  });
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
