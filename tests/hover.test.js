import test from "node:test";
import assert from "node:assert/strict";
import { deferred, harness } from "./harness.js";

function clean(h) {
	assert.deepEqual(h.player.location, h.origin);
	assert.equal(h.record(), undefined);
	assert.equal(h.effects.size, 0);
	assert.equal(h.areas.size, 0);
	assert.equal(h.player.getDynamicProperty("chunk_generator:generating"), false);
	assert.equal(h.player.mode, "Survival");
}

test("a second-section position correction inside a house does not cancel the remaining 918 chunks", async () => {
	let corrected = false;
	const h = harness({ origin: { x: 100.7, y: 70, z: 100.5 },
		getBlock(location) {
			if (location.x === 101 && location.y >= 70 && location.y <= 72) return "minecraft:oak_planks";
			if (location.x === 100 && location.z === 100 && location.y === 70) return "minecraft:torch";
		},
		createArea(id, settings, h) {
			if (id.endsWith("_section_2")) return new Promise(resolve => h.system.runTimeout(resolve, 3));
		},
		tick(h) {
			if (!corrected && [...h.areas.keys()].some(id => id.endsWith("_section_2"))) {
				corrected = true;
				h.player.location = { ...h.origin };
			}
		},
	});
	const result = await h.run(-48, -21, -36, -2);
	assert.equal(corrected, true);
	assert.equal(result.status, "complete");
	assert.equal(result.processed, 918);
	assert.equal(result.successful, 20);
	assert.ok(h.events.some(event => event.kind === "log" && event.text.includes("section=2, phase=loading") && event.text.includes("100.700, 70.000")));
	clean(h);
});

test("gravity during twenty slow loads keeps the player above terrain without canceling generation", async () => {
	let minimum = Infinity;
	const h = harness({
		createArea(id, settings, h) {
			if (id.includes("_section_")) return new Promise(resolve => h.system.runTimeout(resolve, 40));
		},
		tick(h) {
			if (!h.record()?.returnPending) return;
			h.player.velocity.y = -0.125;
			h.player.location.y -= 0.125;
			minimum = Math.min(minimum, h.player.location.y);
		},
	});
	const result = await h.run(-48, -21, -36, -2);
	assert.equal(result.processed, 918);
	assert.equal(result.successful, 20);
	assert.equal(result.status, "complete");
	assert.ok(minimum > h.dimension.heightRange.max + 2);
	assert.ok(h.events.some(event => event.kind === "log" && event.text.includes("Anchor corrected (vertical_drift)")));
	clean(h);
});

test("lava far below the player does not cancel a loaded section", async () => {
	const h = harness({
		getBlock(location) { if (location.x < 90 && location.y < 100) return "minecraft:lava"; },
		createArea(id, settings, h) {
			if (id.includes("_section_")) return new Promise(resolve => h.system.runTimeout(resolve, 3));
		},
	});
	assert.equal((await h.run(0, 9, 0, 1)).status, "complete");
	clean(h);
});

test("a failed aerial correction gives exact diagnostics and returns home immediately", async () => {
	const loading = deferred();
	let denyAnchor = false;
	const h = harness({
		createArea(id) { if (id.includes("_section_")) return loading.promise; },
		teleport(location, settings) { if (denyAnchor && !settings.checkForBlocks) return false; },
	});
	const work = h.controller.start(h.player, 0, 1, 0, 1);
	await h.flush();
	denyAnchor = true;
	h.player.location.y = 200;
	await h.step();
	assert.deepEqual(h.player.location, h.origin);
	assert.equal((await h.settle(work)).processed, 0);
	const warning = h.events.find(event => event.kind === "warning" && event.text.includes("anchor_restore_failed"));
	assert.ok(warning.text.includes("phase=loading"));
	assert.ok(warning.text.includes("200.000"));
	assert.ok(warning.text.includes("324.000"));
	assert.equal(warning.text.includes("Error: Error:"), false);
	loading.resolve();
	await h.flush();
	clean(h);
});

test("a dimension change still cancels safely and identifies the actual dimension", async () => {
	const loading = deferred();
	const h = harness({ createArea(id) { if (id.includes("_section_")) return loading.promise; } });
	const work = h.controller.start(h.player, 0, 1, 0, 1);
	await h.flush();
	h.player.dimension = h.world.getDimension("minecraft:nether");
	await h.step();
	assert.deepEqual(h.player.location, h.origin);
	assert.equal((await h.settle(work)).status, "cancelled");
	assert.ok(h.events.some(event => event.kind === "warning" && event.text.includes("dimension_changed") && event.text.includes("minecraft:nether")));
	loading.resolve();
	await h.flush();
	clean(h);
});

test("pending area creation is actively removed and native cancellation can finish cleanup", async () => {
	const loading = deferred();
	const h = harness({ createArea(id) { if (id.includes("_section_")) return loading.promise; },
		removeArea(id) { if (id.includes("_section_")) loading.reject(new Error("Native area canceled")); },
	});
	const work = h.controller.start(h.player, 0, 1, 0, 1);
	await h.flush();
	h.controller.stop(h.player);
	const result = await h.settle(work);
	assert.equal(result.recoveryPending, false);
	assert.ok(h.events.some(event => event.kind === "area-remove" && event.id.includes("_section_")));
	clean(h);
});

test("area-only cleanup explains what is pending and never teleports a returned player again", async () => {
	const loading = deferred();
	const h = harness({ createArea(id) { if (id.includes("_section_")) return loading.promise; } });
	const work = h.controller.start(h.player, 0, 1, 0, 1);
	await h.flush();
	h.controller.stop(h.player);
	const result = await h.settle(work);
	assert.equal(result.recoveryPending, true);
	assert.equal(h.record().returnPending, false);
	assert.equal(h.effects.size, 0);
	assert.equal(h.areas.size, 0);
	assert.ok(h.messages.some(text => text.includes("Pending cleanup: 1 ticking-area load(s) still settling")));
	const walkedTo = { ...h.origin, x: h.origin.x + 5 };
	h.player.location = { ...walkedTo };
	await h.settle(h.controller.recover(h.player));
	assert.deepEqual(h.player.location, walkedTo);
	loading.resolve();
	await h.flush();
	assert.deepEqual(h.player.location, walkedTo);
	assert.equal(h.record(), undefined);
	assert.ok(h.messages.some(text => text.includes("Pending ticking-area cleanup complete")));
});
