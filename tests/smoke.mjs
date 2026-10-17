import assert from "node:assert/strict";
import worker from "../worker/index.js";

const appUrl = "https://claimready.test";
const testKey = "unit-test-sarvam-key";
const context = {};
const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const root = await worker.fetch(new Request(`${appUrl}/`), {}, context);
assert.equal(root.status, 200);
assert.match(root.headers.get("content-type"), /text\/html/);
const html = await root.text();
assert.match(html, /ClaimReady/);
assert.match(html, /Try sample case/);
assert.match(html, /draftStatement/);
assert.match(html, /Live processing sends these files to Sarvam AI/);
assert.match(html, /does not approve or reject/);

const health = await worker.fetch(new Request(`${appUrl}/api/health`), {}, context);
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { ok: true, configured: false, mode: "demo" });

const noKey = await worker.fetch(new Request(`${appUrl}/api/claim/start`, { method: "POST" }), {}, context);
assert.equal(noKey.status, 503);
assert.match((await noKey.json()).error, /not configured/);

const missing = await worker.fetch(new Request(`${appUrl}/missing`), {}, context);
assert.equal(missing.status, 404);

const originalFetch = globalThis.fetch;
const upstreamCalls = [];
globalThis.fetch = async (url, options = {}) => {
  upstreamCalls.push({ url: String(url), options });
  assert.equal(new Headers(options.headers).get("api-subscription-key"), testKey);
  const parsed = new URL(String(url));
  if (parsed.pathname === "/speech-to-text") return respond({ transcript: "I was admitted for dengue on 12 October 2026. The bill is ₹38,400." });
  if (parsed.pathname === "/doc-ai/v1/job/extract") {
    const form = options.body;
    assert.equal(form.get("output_format"), "json");
    assert.equal(form.get("language"), "en-IN");
    const schema = JSON.parse(form.get("schema"));
    assert.equal(schema.type, "object");
    const file = form.get("file");
    return respond({ job_id: file.name.startsWith("policy") ? "policy-job-1" : "bill-job-1", status: "pending" }, 201);
  }
  if (parsed.pathname.endsWith("/status")) return respond({ job_id: parsed.pathname.includes("policy") ? "policy-job-1" : "bill-job-1", status: "completed", usage: { pages_total: 1, pages_processed: 1 } });
  if (parsed.pathname.endsWith("/results")) {
    if (parsed.pathname.includes("policy-job-1")) return respond({
      type: "extract", status: "completed", result: { insured_name: "Aarav Mehta", policy_number: "HR-24810-77", sum_insured: "₹5,00,000" },
      annotations: { insured_name: { confidence: 0.97, sources: [{ filename: "policy.pdf", page_num: 1 }] }, policy_number: { confidence: 0.94, sources: [{ filename: "policy.pdf", page_num: 1 }] } },
    });
    return respond({
      type: "extract", status: "completed", result: { patient_name: "Aarav Mehta", hospital_name: "City Hospital", admission_date: "2026-10-13", diagnosis: "Dengue", invoice_number: "INV-22", total_amount: "₹38,400" },
      annotations: { patient_name: { confidence: 0.99, sources: [{ filename: "bill.pdf", page_num: 1 }] }, admission_date: { confidence: 0.96, sources: [{ filename: "bill.pdf", page_num: 1 }] }, total_amount: { confidence: 0.99, sources: [{ filename: "bill.pdf", page_num: 1 }] } },
    });
  }
  if (parsed.pathname === "/v1/chat/completions") {
    const requestBody = JSON.parse(options.body);
    assert.equal(requestBody.model, "sarvam-105b");
    assert.equal(requestBody.reasoning_effort, null);
    assert.equal(requestBody.response_format.json_schema.strict, true);
    return respond({ choices: [{ message: { content: JSON.stringify({
      narrative_facts: { patient_name: "Aarav Mehta", admission_date: "2026-10-12", claimed_amount: "₹38,400", diagnosis: "Dengue" },
      summary: "The narration and documents describe a dengue hospital visit and a bill of ₹38,400.",
      next_steps: ["Confirm the admission date with the hospital."],
      draft_statement: "I was admitted for dengue on 12 October 2026. My hospital bill is ₹38,400.",
    }) } }] });
  }
  if (parsed.pathname === "/text-to-speech") {
    const requestBody = JSON.parse(options.body);
    assert.equal(requestBody.model, "bulbul:v3");
    assert.equal(requestBody.language_code, "hi-IN");
    return respond({ audios: ["UklGR-test-audio"] });
  }
  throw new Error(`Unexpected upstream request: ${parsed.pathname}`);
};

try {
  const form = new FormData();
  form.set("audio", new File(["sample voice bytes"], "narration.webm", { type: "audio/webm" }));
  form.set("policy", new File(["sample policy bytes"], "policy.pdf", { type: "application/pdf" }));
  form.set("bill", new File(["sample bill bytes"], "bill.pdf", { type: "application/pdf" }));
  form.set("language", "hi-IN");
  form.set("document_language", "en-IN");

  const started = await worker.fetch(new Request(`${appUrl}/api/claim/start`, {
    method: "POST", headers: { origin: appUrl }, body: form,
  }), { SARVAM_API_KEY: testKey }, context);
  assert.equal(started.status, 200);
  const startBody = await started.json();
  assert.match(startBody.transcript, /12 October/);
  assert.equal(startBody.files.length, 3);
  assert.equal(startBody.files.find((file) => file.key === "policy").sha256.length, 64);
  assert.match(startBody.token, /\./);

  const status = await worker.fetch(new Request(`${appUrl}/api/claim/status`, {
    method: "POST", headers: { "content-type": "application/json", origin: appUrl }, body: JSON.stringify({ token: startBody.token }),
  }), { SARVAM_API_KEY: testKey }, context);
  assert.equal(status.status, 200);
  assert.deepEqual((await status.json()).documents.map((doc) => doc.status), ["completed", "completed"]);

  const analyzed = await worker.fetch(new Request(`${appUrl}/api/claim/analyze`, {
    method: "POST", headers: { "content-type": "application/json", origin: appUrl }, body: JSON.stringify({ token: startBody.token, transcript: startBody.transcript }),
  }), { SARVAM_API_KEY: testKey }, context);
  assert.equal(analyzed.status, 200);
  const packet = (await analyzed.json()).packet;
  assert.equal(packet.mode, "live");
  assert.match(packet.summary, /dengue/);
  assert.equal(packet.facts.find((fact) => fact.label === "Patient name").source.filename, "bill.pdf");
  assert.equal(packet.facts.find((fact) => fact.label === "Patient name").confidence, 0.99);
  assert.ok(packet.checks.some((check) => check.field === "Admission date" && check.voice_value === "2026-10-12" && check.document_value === "2026-10-13"));
  assert.match(packet.clarification_question, /admission date/);
  assert.equal(packet.documents.find((file) => file.label === "Policy").sha256.length, 64);

  const tamperedToken = (startBody.token[0] === "a" ? "b" : "a") + startBody.token.slice(1);
  const tampered = await worker.fetch(new Request(`${appUrl}/api/claim/status`, {
    method: "POST", headers: { "content-type": "application/json", origin: appUrl }, body: JSON.stringify({ token: tamperedToken }),
  }), { SARVAM_API_KEY: testKey }, context);
  assert.equal(tampered.status, 400);

  const wrongOriginForm = new FormData();
  const wrongOrigin = await worker.fetch(new Request(`${appUrl}/api/claim/start`, {
    method: "POST", headers: { origin: "https://attacker.test" }, body: wrongOriginForm,
  }), { SARVAM_API_KEY: testKey }, context);
  assert.equal(wrongOrigin.status, 403);

  const speech = await worker.fetch(new Request(`${appUrl}/api/claim/speak`, {
    method: "POST", headers: { "content-type": "application/json", origin: appUrl }, body: JSON.stringify({ text: "Confirm the admission date.", language: "hi-IN" }),
  }), { SARVAM_API_KEY: testKey }, context);
  assert.equal(speech.status, 200);
  assert.deepEqual(await speech.json(), { audio: "UklGR-test-audio", format: "wav" });
  assert.equal(upstreamCalls.filter((call) => call.url.includes("/doc-ai/v1/job/extract")).length, 2);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("ClaimReady smoke and mocked live-flow tests passed.");
