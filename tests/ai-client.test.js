// The Anthropic client against a real request/response shape, mirroring
// tests/paypal-client.test.js: no network, `fetch` is injected, and the point is to
// prove what the client does with a REAL reply shape, not a convenient one.
//
// Built on the platform Response object (available on Node 20+) rather than a
// hand-rolled stub, because the SDK calls response.clone() internally — a plain
// object with just `.json()`/`.text()` is enough for the PayPal client's own
// fetch wrapper, but not enough for this one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WeightProposer } from "../src/ai/client.js";
import { AiConfigError } from "../src/ai/config.js";
import { proposalSchema } from "../src/ai/proposal.js";

const PEOPLE = ["p-ada", "p-bo"];
const ROOMS = [
  { personId: "p-ada", name: "Ada Moreno", facts: "Bedroom 1 — private bathroom" },
  { personId: "p-bo", name: "Bo Fitzgerald", facts: "Bedroom 2 — shares the hall bathroom" },
];

/** A fetch that records the one request it was given and replies with a fixed body. */
function fakeFetch(body, { status = 200 } = {}) {
  const seen = [];
  const impl = async (url, init = {}) => {
    seen.push({ url: String(url), init, parsedBody: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  impl.seen = seen;
  return impl;
}

const toolUseReply = (input, { leadingText = false } = {}) => ({
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5-20251001",
  content: [
    ...(leadingText ? [{ type: "text", text: "Here is my proposal." }] : []),
    { type: "tool_use", id: "toolu_01", name: "propose_rent_weights", input },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 10, output_tokens: 10 },
});

const GOOD_INPUT = {
  weights: { "p-ada": 1.2, "p-bo": 1 },
  basis: { "p-ada": "Larger room with a private bathroom.", "p-bo": "Ordinary room, shares the hall bathroom." },
  unknowns: [],
};

test("a tool-use reply is returned as the raw proposal, unvalidated", async () => {
  const fetchImpl = fakeFetch(toolUseReply(GOOD_INPUT));
  const client = new WeightProposer({ apiKey: "sk-test", fetchImpl });
  const result = await client.proposeWeights({ personIds: PEOPLE, rooms: ROOMS });
  assert.deepEqual(result, GOOD_INPUT);
});

test("the request steers toward the tool via auto choice + strict mode, and sends the household's facts, never a dollar figure", async () => {
  const fetchImpl = fakeFetch(toolUseReply(GOOD_INPUT));
  const client = new WeightProposer({ apiKey: "sk-test", model: "claude-opus-5", fetchImpl });
  await client.proposeWeights({ personIds: PEOPLE, rooms: ROOMS, context: "Ada is away in January." });

  assert.equal(fetchImpl.seen.length, 1);
  const { parsedBody } = fetchImpl.seen[0];
  assert.equal(parsedBody.model, "claude-opus-5");
  // Not forced: Opus 5 runs with thinking on by default, and a forced
  // tool_choice is not compatible with thinking being enabled.
  assert.deepEqual(parsedBody.tool_choice, { type: "auto" });
  assert.deepEqual(parsedBody.thinking, { type: "adaptive" });
  assert.equal(parsedBody.tools.length, 1);
  assert.equal(parsedBody.tools[0].strict, true, "strict mode is what still guarantees the schema with tool_choice at auto");
  assert.deepEqual(parsedBody.tools[0].input_schema, proposalSchema(PEOPLE));

  const prompt = parsedBody.messages[0].content;
  assert.match(prompt, /Bedroom 1 — private bathroom/);
  assert.match(prompt, /Bedroom 2 — shares the hall bathroom/);
  assert.match(prompt, /Ada is away in January/);
  assert.match(prompt, /propose_rent_weights/, "the tool is named explicitly since tool_choice no longer forces it");
  assert.ok(!/\$\d/.test(prompt), "the prompt must not contain a dollar figure");
});

test("a reply with leading text before the tool call still yields the proposal", async () => {
  const fetchImpl = fakeFetch(toolUseReply(GOOD_INPUT, { leadingText: true }));
  const client = new WeightProposer({ apiKey: "sk-test", fetchImpl });
  const result = await client.proposeWeights({ personIds: PEOPLE, rooms: ROOMS });
  assert.deepEqual(result, GOOD_INPUT);
});

test("a reply that never uses the tool is refused, not guessed at from the text", async () => {
  const textOnlyReply = {
    id: "msg_02", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text: "I would rather not propose weights." }],
    stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 },
  };
  const client = new WeightProposer({ apiKey: "sk-test", fetchImpl: fakeFetch(textOnlyReply) });
  await assert.rejects(
    () => client.proposeWeights({ personIds: PEOPLE, rooms: ROOMS }),
    (error) => { assert.ok(error instanceof AiConfigError); assert.match(error.message, /without using the required tool/); return true; },
  );
});
