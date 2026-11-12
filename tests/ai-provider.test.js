// Configuration failures for the AI mode, mirroring tests/payment-config.test.js:
// each needs its own clear message, and the default must be "off" so nothing calls
// a model by accident.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMode, AiConfigError, ALLOCATION_MODEL } from "../src/ai/config.js";
import { resolveAi } from "../src/ai/provider.js";
import { WeightProposer } from "../src/ai/client.js";

/** assert.throws does not hand back the error, and these tests are about the message. */
const caught = (fn) => { try { fn(); return null; } catch (error) { return error; } };

test("the default mode is off, so nothing calls a model by accident", () => {
  assert.equal(resolveMode({}), "off");
});

test("an unrecognised mode is refused rather than guessed", () => {
  assert.throws(() => resolveMode({ AI_MODE: "on" }), AiConfigError);
  assert.throws(() => resolveMode({ AI_MODE: "live" }), /must be one of/);
});

test("off mode resolves with no client and is not available", () => {
  const ai = resolveAi({ env: { AI_MODE: "off" } });
  assert.equal(ai.mode, "off");
  assert.equal(ai.client, null);
  assert.equal(ai.available, false);
});

test("anthropic mode with no key names exactly what is missing", () => {
  const error = caught(() => resolveAi({ env: { AI_MODE: "anthropic" } }));
  assert.ok(error instanceof AiConfigError, `expected AiConfigError, got ${error}`);
  assert.match(error.message, /ANTHROPIC_API_KEY/);
  assert.match(error.fix, /AI_MODE=off/);
});

test("anthropic mode with a key resolves to an available client on the default model", () => {
  const ai = resolveAi({ env: { AI_MODE: "anthropic", ANTHROPIC_API_KEY: "sk-test-not-a-credential" } });
  assert.equal(ai.mode, "anthropic");
  assert.equal(ai.available, true);
  assert.equal(ai.client.model, ALLOCATION_MODEL);
  assert.match(ai.client.describe(), new RegExp(ALLOCATION_MODEL));
});

test("ANTHROPIC_MODEL overrides the default, so a cheaper or different model can be chosen without a code change", () => {
  const ai = resolveAi({ env: { AI_MODE: "anthropic", ANTHROPIC_API_KEY: "sk-test-not-a-credential", ANTHROPIC_MODEL: "claude-sonnet-5" } });
  assert.equal(ai.client.model, "claude-sonnet-5");
});

test("the client itself refuses to construct with no key, independent of the mode resolver", () => {
  assert.throws(() => new WeightProposer({ apiKey: "" }), AiConfigError);
  assert.throws(() => new WeightProposer({}), /needs an API key/);
});

test("the default model id is the one verified live against the real API (npm run verify:ai)", () => {
  assert.equal(ALLOCATION_MODEL, "claude-opus-5-5");
});
