import test from "node:test";
import assert from "node:assert/strict";
import { deferred, harness } from "./harness.js";

const BACKGROUND = "chunk_generator:pending_areas";
const queued = h => JSON.parse(h.properties.get(BACKGROUND) ?? "[]");

function waiting(options = {}) {
	const load = deferred();
	let oldId;
	const h = harness({ ...options, createArea(id, settings, h) {
		if (id.includes("_section_") && !oldId) { oldId = id; return load.promise; }
		return options.nextArea?.(id, settings, h);
	} });
	return { h, load, id: () => oldId };
}
async function cancel(w) {
	const work = w.h.controller.start(w.h.player, 0, 1, 0, 1);
	await w.h.flush();
	w.h.controller.stop(w.h.player);
	return w.h.settle(work);
}

test("an absent abandoned area stays journaled without blocking a new generation", async () => {
	const w = waiting();
	const result = await cancel(w);
	assert.equal(result.recoveryPending, true);
	assert.equal(result.generationBlocked, false);
	assert.equal(w.h.record(), undefined);
	assert.deepEqual(queued(w.h), [w.id()]);
	assert.equal(w.h.areas.size, 0);
	assert.equal((await w.h.run(0, 2, 0, 1)).status, "complete");
	assert.deepEqual(queued(w.h), [w.id()]);
	w.load.resolve();
	await w.h.flush();
	assert.deepEqual(queued(w.h), []);
	assert.equal(w.h.record(), undefined);
});

test("a late old request cannot clear or move another running job", async () => {
	const next = deferred();
	const w = waiting({ nextArea(id) { if (id.includes("_section_")) return next.promise; } });
	await cancel(w);
	const work = w.h.controller.start(w.h.player, 2, 3, 2, 3);
	await w.h.flush();
	const currentId = w.h.record().jobId;
	const position = { ...w.h.player.location };
	w.load.resolve();
	await w.h.flush();
	assert.equal(w.h.record().jobId, currentId);
	assert.equal(w.h.controller.isGenerating(w.h.player), true);
	assert.deepEqual(w.h.player.location, position);
	assert.equal(w.h.effects.size, 2);
	assert.deepEqual(queued(w.h), []);
	next.resolve();
	assert.equal((await w.h.settle(work)).status, "complete");
	assert.equal(w.h.record(), undefined);
	assert.equal(w.h.areas.size, 0);
});

test("persisted background area ownership is cleaned on restart", async () => {
	const w = waiting();
	await cancel(w);
	const after = harness({ properties: [...w.h.properties], areas: [[w.id(), { identifier: w.id(), isFullyLoaded: true }]] });
	assert.deepEqual(queued(after), []);
	assert.equal(after.areas.size, 0);
	assert.equal((await after.run()).status, "complete");
});

test("an actual area that cannot be removed still blocks and tells the player how to retry", async () => {
	let fail = true;
	const w = waiting({ removeArea(id) { if (fail && id.includes("_section_")) throw new Error("Area removal denied"); } });
	const result = await cancel(w);
	assert.equal(result.generationBlocked, true);
	assert.ok(w.h.record());
	assert.deepEqual(queued(w.h), []);
	assert.equal((await w.h.run()).status, "refused");
	assert.ok(w.h.messages.some(text => text.includes("/chunk_generator:stop") && text.includes("Cleanup pending")));
	fail = false;
	await w.h.settle(w.h.controller.recover(w.h.player));
	assert.equal(w.h.record(), undefined);
	assert.equal((await w.h.run()).status, "complete");
	w.load.resolve();
	await w.h.flush();
	assert.deepEqual(queued(w.h), []);
});

test("failed background persistence cannot drop the foreground recovery record", async () => {
	let fail = true;
	const w = waiting({ save(key, value) { if (fail && key === BACKGROUND && value !== undefined) throw new Error("Storage unavailable"); } });
	assert.equal((await cancel(w)).generationBlocked, true);
	assert.ok(w.h.record());
	assert.equal((await w.h.run()).status, "refused");
	fail = false;
	await w.h.settle(w.h.controller.recover(w.h.player));
	assert.equal(w.h.record(), undefined);
	assert.deepEqual(queued(w.h), [w.id()]);
	assert.equal((await w.h.run()).status, "complete");
	w.load.resolve();
	await w.h.flush();
	assert.deepEqual(queued(w.h), []);
});

test("running, canceling and background-only states give the player actionable instructions", async () => {
	const w = waiting();
	const work = w.h.controller.start(w.h.player, 0, 1, 0, 1);
	await w.h.flush();
	assert.equal((await w.h.controller.start(w.h.player, 0, 1, 0, 1)).status, "refused");
	assert.ok(w.h.messages.at(-1).includes("Wait for section progress, or use /chunk_generator:stop"));
	w.h.controller.stop(w.h.player);
	assert.ok(w.h.messages.at(-1).includes("Cancellation requested"));
	await w.h.settle(work);
	assert.ok(w.h.messages.at(-1).includes("new generation is available"));
	w.h.controller.stop(w.h.player);
	await w.h.flush();
	assert.ok(w.h.messages.at(-1).includes("No active player recovery"));
	assert.ok(w.h.messages.at(-1).includes("new generation is available"));
	w.load.resolve();
	await w.h.flush();
});

test("a changed landing gives its coordinates and retry instructions without dropping recovery", async () => {
	let changed = false;
	const h = harness({ blockStates(location) { return location.y === 69 ? { state: changed } : {}; },
		createArea(id) { if (id.includes("_section_")) changed = true; },
	});
	assert.equal((await h.run()).generationBlocked, true);
	await h.settle(h.controller.recover(h.player, true));
	const instruction = h.messages.at(-1);
	assert.ok(instruction.includes("Return pending at (100.500, 70.000, 100.500)"));
	assert.ok(instruction.includes("Restore the floor/clear obstructions"));
	assert.ok(instruction.includes("/chunk_generator:stop"));
	assert.ok(instruction.includes("expected"));
	assert.ok(h.record());
	changed = false;
	await h.settle(h.controller.recover(h.player));
	assert.equal(h.record(), undefined);
});

test("an offline owner is identified so another player knows who must reconnect", async () => {
	const w = waiting();
	const work = w.h.controller.start(w.h.player, 0, 1, 0, 1);
	await w.h.flush();
	w.h.player.isValid = false;
	w.h.controller.onLeave(w.h.player.id);
	assert.equal((await w.h.settle(work)).generationBlocked, true);
	const other = { ...w.h.player, id: "player-2", isValid: true, sendMessage: text => w.h.messages.push(text) };
	assert.equal((await w.h.controller.start(other, 0, 1, 0, 1)).status, "refused");
	assert.ok(w.h.messages.at(-1).includes("Recovery belongs to Tester"));
	assert.ok(w.h.messages.at(-1).includes("must reconnect"));
	w.load.resolve();
	await w.h.flush();
	w.h.player.isValid = true;
	await w.h.settle(w.h.controller.recover(w.h.player));
	assert.equal(w.h.record(), undefined);
});
