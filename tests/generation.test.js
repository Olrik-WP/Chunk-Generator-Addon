import test from "node:test";
import assert from "node:assert/strict";
import { deferred, harness } from "./harness.js";

const RESISTANCE = "minecraft:resistance";
const SLOW_FALLING = "minecraft:slow_falling";
function assertClean(h) {
	assert.deepEqual(h.player.location, h.origin);
	assert.equal(h.player.mode, "Survival");
	assert.equal(h.player.getDynamicProperty("chunk_generator:generating"), false);
	assert.equal(h.areas.size, 0);
	assert.equal(h.record(), undefined);
	assert.equal(h.effects.size, 0);
	assert.equal([...h.blocks.values()].some(block => block.typeId === "minecraft:barrier"), false);
}

test("the actual controller retains 360 chunks, nine 8x8 sections and teleport-before-load ordering", async () => {
	const h = harness({ createArea(id, settings, h) {
		if (id.includes("_section_")) {
			assert.equal(h.player.location.x, settings.from.x);
			assert.equal(h.player.location.z, settings.from.z);
			assert.equal(h.player.location.y, h.dimension.heightRange.max + 4);
		}
	} });
	const result = await h.run(-19, -1, -24, -4);
	assert.equal(result.processed, 360);
	assert.equal(result.successful, 9);
	assert.equal(result.status, "complete");
	assert.equal(h.events.filter(event => event.kind === "area-create" && event.id.includes("_section_")).length, 9);
	assert.equal(h.events.filter(event => event.kind === "block").length, 720);
	for (const event of h.events.filter(event => event.kind === "teleport")) {
		assert.equal(event.protected, true);
		assert.equal(event.settings.keepVelocity, false);
	}
	assert.deepEqual(h.player.rotation, { x: 12, y: -37 });
	assertClean(h);
});

test("no capacity is detected before any remote teleport", async () => {
	const h = harness({ hasCapacity(settings) { return settings.to.x - settings.from.x < 3; } });
	const result = await h.run();
	assert.equal(result.failed, 1);
	assert.equal(result.processed, 0);
	assert.equal(h.events.filter(event => event.kind === "teleport").length, 0);
	assertClean(h);
});

test("failed area creation returns the player and cleans a partially created area", async () => {
	const h = harness({ createArea(id) { if (id.includes("_section_")) throw new Error("Injected create failure"); } });
	const result = await h.run();
	assert.equal(result.failed, 1);
	assert.equal(result.processed, 0);
	assertClean(h);
});

test("unloaded chunks and read exceptions are not counted as successes", async () => {
	const h = harness({ getBlock(location) { if (location.x < 16) return null; if (location.x < 32) throw new Error("Read failed"); } });
	const result = await h.run(0, 3, 0, 1);
	assert.equal(result.processed, 1);
	assert.equal(result.partial, 1);
	assert.equal(result.status, "partial");
	assertClean(h);
});

test("cancellation during asynchronous creation returns immediately and removes late areas", async () => {
	const loading = deferred();
	const h = harness({ createArea(id) { if (id.includes("_section_")) return loading.promise; } });
	const work = h.controller.start(h.player, 0, 1, 0, 1);
	await h.flush();
	assert.notDeepEqual(h.player.location, h.origin);
	h.controller.stop(h.player);
	assert.deepEqual(h.player.location, h.origin);
	const result = await h.settle(work);
	assert.equal(result.processed, 0);
	assert.equal(result.cancelled, 1);
	assert.equal(result.recoveryPending, true);
	loading.resolve();
	await h.flush();
	assertClean(h);
});

test("disconnect retains recovery until reconnection, including effects and generation flag", async () => {
	const loading = deferred();
	const h = harness({ createArea(id) { if (id.includes("_section_")) return loading.promise; } });
	const work = h.controller.start(h.player, 0, 1, 0, 1);
	await h.flush();
	h.player.isValid = false;
	h.controller.onLeave(h.player.id);
	const result = await h.settle(work);
	assert.equal(result.status, "cancelled");
	assert.equal(h.record().returnPending, true);
	loading.resolve();
	await h.flush();
	h.player.isValid = true;
	await h.settle(h.controller.recover(h.player));
	assertClean(h);
});

test("a second start cannot overwrite the first player's recovery or effects", async () => {
	const loading = deferred();
	const h = harness({ createArea(id) { if (id.includes("_section_")) return loading.promise; } });
	const work = h.controller.start(h.player, 0, 1, 0, 1);
	await h.flush();
	const before = h.record();
	assert.equal((await h.controller.start(h.player, 0, 2, 0, 2)).status, "refused");
	const secondPlayer = { ...h.player, id: "player-2" };
	assert.equal((await h.controller.start(secondPlayer, 0, 2, 0, 2)).status, "refused");
	assert.deepEqual(h.record(), before);
	h.controller.stop(h.player);
	await h.settle(work);
	loading.resolve();
	await h.flush();
	assertClean(h);
});

test("void guard restores the protected aerial anchor and allows the load to finish", async () => {
	const loading = deferred();
	const h = harness({ createArea(id) { if (id.includes("_section_")) return loading.promise; } });
	const work = h.controller.start(h.player, 0, 1, 0, 1);
	await h.flush();
	h.player.location.y = h.dimension.heightRange.min + 10;
	h.player.velocity.y = -10;
	await h.step();
	assert.deepEqual(h.player.location, { x: 0, y: 324, z: 0 });
	assert.equal(h.player.velocity.y, 0);
	assert.equal(h.controller.isGenerating(h.player), true);
	loading.resolve();
	assert.equal((await h.settle(work)).processed, 1);
	assertClean(h);
});

test("preexisting effects keep their strength, particles, and naturally remaining duration", async () => {
	const h = harness({ effects: {
		[RESISTANCE]: { amplifier: 5, duration: 1800, showParticles: true },
		[SLOW_FALLING]: { amplifier: 1, duration: 1800, showParticles: false },
	} });
	const result = await h.run();
	assert.equal(result.status, "complete");
	assert.equal(h.events.filter(event => event.kind.startsWith("effect-")).length, 0);
	assert.equal(h.player.getEffect(RESISTANCE).duration, 1800 - h.system.currentTick);
	assert.equal(h.player.getEffect(RESISTANCE).amplifier, 5);
	assert.equal(h.effects.get(RESISTANCE).showParticles, true);
	assert.equal(h.effects.get(SLOW_FALLING).showParticles, false);
	assert.equal(h.record(), undefined);
});

test("a weaker preexisting resistance is preserved and causes refusal before effects or movement", async () => {
	const h = harness({ effects: { [RESISTANCE]: { amplifier: 1, duration: 1800, showParticles: true } } });
	assert.equal((await h.run()).status, "failed");
	assert.equal(h.player.getEffect(RESISTANCE).amplifier, 1);
	assert.equal(h.events.filter(event => event.kind === "teleport" || event.kind.startsWith("effect-")).length, 0);
	assert.equal(h.record(), undefined);
});

test("partial protection failure is cleaned before any teleport", async () => {
	const h = harness({ addEffect(typeId) { if (typeId === SLOW_FALLING) throw new Error("Effect denied"); } });
	assert.equal((await h.run()).status, "failed");
	assert.equal(h.events.filter(event => event.kind === "teleport").length, 0);
	assertClean(h);
});

test("silently unsuccessful effect application is detected before movement", async () => {
	const h = harness({ addEffect() { return false; } });
	assert.equal((await h.run()).status, "failed");
	assert.equal(h.events.filter(event => event.kind === "teleport").length, 0);
	assertClean(h);
});

test("a container in the initial dirty-block position is never replaced", async () => {
	const h = harness({ getBlock(location) { if (location.x === 8 && location.z === 8 && location.y === 319) return "minecraft:chest"; } });
	assert.equal((await h.run()).processed, 1);
	const chest = h.dimension.getBlock({ x: 8, y: 319, z: 8 });
	assert.equal(chest.typeId, "minecraft:chest");
	assert.deepEqual(chest.payload, { example: "container contents" });
	assert.equal(h.events.some(event => event.kind === "block" && event.location.y === 319), false);
	assertClean(h);
});

test("a transient block restoration error is retried independently of player return", async () => {
	let failed = false;
	const h = harness({ setPermutation(block, next) {
		if (!failed && block.typeId === "minecraft:barrier" && next.type.id === "minecraft:air") { failed = true; throw new Error("Restore failed once"); }
	} });
	assert.equal((await h.run(0, 2, 0, 1)).processed, 0);
	assertClean(h);
});

test("area removal failure does not prevent the return, effect cleanup or flag reset", async () => {
	let fail = true;
	const h = harness({ removeArea() { if (fail) throw new Error("Removal failed"); } });
	const result = await h.run();
	assert.equal(result.recoveryPending, true);
	assert.deepEqual(h.player.location, h.origin);
	assert.equal(h.effects.size, 0);
	assert.equal(h.player.getDynamicProperty("chunk_generator:generating"), false);
	fail = false;
	await h.settle(h.controller.recover(h.player));
	assertClean(h);
});

test("a no-op return is detected and its recovery record survives until a verified return", async () => {
	let fail = true;
	const h = harness({ teleport(location) { if (fail && location.y === 70) return false; } });
	const result = await h.run();
	assert.equal(result.recoveryPending, true);
	assert.equal(h.record().returnPending, true);
	assert.equal(h.effects.size, 2);
	fail = false;
	await h.settle(h.controller.recover(h.player));
	assertClean(h);
});

test("empty and out-of-bounds selections are refused before changing state", async () => {
	const h = harness();
	for (const bounds of [[0, 0, 0, 1], [0, 1.5, 0, 1], [0, 2000000, 0, 1]]) assert.equal((await h.run(...bounds)).status, "refused");
	assert.equal(h.events.filter(event => event.kind === "teleport").length, 0);
	assertClean(h);
});

test("late completion during the final landing tick cannot erase an active recovery record", async () => {
	const loading = deferred();
	const h = harness({ createArea(id) { if (id.includes("_section_")) return loading.promise; } });
	const work = h.controller.start(h.player, 0, 1, 0, 1);
	await h.flush();
	h.controller.stop(h.player);
	loading.resolve();
	await h.settle(work);
	assertClean(h);
});

test("an abandoned creation that rejects late has a rejection handler and is cleaned", async () => {
	const loading = deferred();
	const h = harness({ createArea(id) { if (id.includes("_section_")) return loading.promise; } });
	const work = h.controller.start(h.player, 0, 1, 0, 1);
	await h.flush();
	h.controller.stop(h.player);
	await h.settle(work);
	loading.reject(new Error("Late create rejection"));
	await h.flush();
	assertClean(h);
});

test("load timeout returns safely and retains ownership until the late creation is removed", async () => {
	const loading = deferred();
	const h = harness({ createArea(id) { if (id.includes("_section_")) return loading.promise; } });
	const result = await h.run();
	assert.equal(result.processed, 0);
	assert.equal(result.failed, 1);
	assert.equal(result.recoveryPending, true);
	assert.deepEqual(h.player.location, h.origin);
	assert.equal(h.effects.size, 0);
	loading.resolve();
	await h.flush();
	assertClean(h);
});

test("protection is renewed through multiple slow sections without changing game mode", async () => {
	const h = harness({ createArea(id, settings, h) {
		if (id.includes("_section_")) return new Promise(resolve => h.system.runTimeout(resolve, 500));
	} });
	const result = await h.run(0, 17, 0, 1);
	assert.equal(result.processed, 17);
	assert.equal(result.successful, 3);
	assert.equal(result.status, "complete");
	assert.ok(h.events.filter(event => event.kind === "effect-add" && event.typeId === RESISTANCE).length >= 3);
	assertClean(h);
});

test("an expiring preexisting effect triggers return without extending or recreating it", async () => {
	const loading = deferred();
	const h = harness({
		effects: { [RESISTANCE]: { amplifier: 4, duration: 120, showParticles: true } },
		createArea(id) { if (id.includes("_section_")) return loading.promise; },
	});
	const result = await h.run();
	assert.equal(result.status, "cancelled");
	assert.deepEqual(h.player.location, h.origin);
	assert.equal(h.events.some(event => event.typeId === RESISTANCE && event.kind.startsWith("effect-")), false);
	assert.equal(h.player.getEffect(RESISTANCE).duration, 120 - h.system.currentTick);
	loading.resolve();
	await h.flush();
	assert.equal(h.record(), undefined);
});

test("infinite preexisting effects are left completely unchanged", async () => {
	const h = harness({ effects: {
		[RESISTANCE]: { amplifier: 4, duration: -1 }, [SLOW_FALLING]: { amplifier: 0, duration: -1 },
	} });
	assert.equal((await h.run()).status, "complete");
	assert.equal(h.events.some(event => event.kind.startsWith("effect-")), false);
	assert.equal(h.player.getEffect(RESISTANCE).duration, -1);
	assert.equal(h.record(), undefined);
});

test("effect cleanup failures remain recoverable and do not prevent other cleanup", async () => {
	let fail = true;
	const h = harness({ removeEffect(typeId) { if (fail && typeId === SLOW_FALLING) throw new Error("Remove effect failed"); } });
	assert.equal((await h.run()).recoveryPending, true);
	assert.equal(h.player.getEffect(RESISTANCE), undefined);
	assert.ok(h.player.getEffect(SLOW_FALLING));
	assert.equal(h.areas.size, 0);
	assert.equal(h.player.getDynamicProperty("chunk_generator:generating"), false);
	fail = false;
	await h.settle(h.controller.recover(h.player));
	assertClean(h);
});

for (const hazard of ["minecraft:lava", "minecraft:stone", null]) {
	test(`the watchdog restores altitude and continues above terrain or missing data: ${hazard}`, async () => {
		const loading = deferred();
		const h = harness({
			getBlock(location) { if (location.x < 10 && location.y === 200) return hazard; },
			createArea(id) { if (id.includes("_section_")) return loading.promise; },
		});
		const work = h.controller.start(h.player, 0, 1, 0, 1);
		await h.flush();
		h.player.location = { x: 0.5, y: 200, z: 0.5 };
		await h.step();
		assert.deepEqual(h.player.location, { x: 0, y: 324, z: 0 });
		assert.equal(h.controller.isGenerating(h.player), true);
		loading.resolve();
		assert.equal((await h.settle(work)).processed, 1);
		assertClean(h);
	});
}

for (const [dimensionId, max] of [["minecraft:nether", 128], ["minecraft:the_end", 256]]) {
	test(`dimension-aware travel and air search below a solid ceiling: ${dimensionId}`, async () => {
		const h = harness({ dimensionId, heightRange: { min: 0, max }, getBlock(location) {
			if (location.x < 16 && location.y >= max - 10) return "minecraft:bedrock";
		} });
		assert.equal((await h.run()).processed, 1);
		assert.equal(h.events.find(event => event.kind === "teleport").location.y, max + 4);
		assert.equal(h.events.some(event => event.kind === "block" && event.from !== "minecraft:air" && event.from !== "minecraft:barrier"), false);
		assert.equal(h.player.dimension.id, dimensionId);
		assertClean(h);
	});
}

test("a chunk with no sampled air is reported failed and is never modified", async () => {
	const h = harness({ origin: { x: 100.5, y: 6, z: 100.5 }, heightRange: { min: 0, max: 16 }, getBlock(location) {
		if (location.x < 16) return "minecraft:stone";
	} });
	const result = await h.run();
	assert.equal(result.processed, 0);
	assert.equal(result.failed, 1);
	assert.equal(h.events.some(event => event.kind === "block"), false);
	assertClean(h);
});

test("a persistent block restore error stops later chunks and is repaired on recovery", async () => {
	let fail = true;
	const h = harness({ setPermutation(block, next) {
		if (fail && block.typeId === "minecraft:barrier" && next.type.id === "minecraft:air") throw new Error("Restore unavailable");
	} });
	const result = await h.run(0, 2, 0, 1);
	assert.equal(result.processed, 0);
	assert.equal(result.failed, 1);
	assert.ok(h.record().pendingBlock);
	assert.deepEqual(h.player.location, h.origin);
	assert.equal(h.effects.size, 0);
	fail = false;
	await h.settle(h.controller.recover(h.player));
	assertClean(h);
});

test("a saved recovery can be read by a fresh controller after a simulated server restart", async () => {
	const loading = deferred();
	const before = harness({ createArea(id) { if (id.includes("_section_")) return loading.promise; } });
	void before.controller.start(before.player, 0, 1, 0, 1);
	await before.flush();
	const after = harness({ properties: [...before.properties], location: before.player.location, generating: true,
		effects: {
			[RESISTANCE]: { amplifier: 4, duration: 1100, showParticles: false },
			[SLOW_FALLING]: { amplifier: 0, duration: 1100, showParticles: false },
		},
	});
	assert.ok(after.record().returnPending);
	await after.settle(after.controller.recover(after.player));
	assertClean(after);
});

test("recovery reloads the original area when it is unavailable after restart", async () => {
	const before = harness();
	const waiting = deferred();
	before.options.createArea = id => id.includes("_section_") ? waiting.promise : undefined;
	void before.controller.start(before.player, 0, 1, 0, 1);
	await before.flush();
	let homeLoaded = false;
	const after = harness({ properties: [...before.properties], location: before.player.location,
		getBlock(location) { if (!homeLoaded && location.x > 90) return null; },
		createArea(id) { if (id.endsWith("_home")) homeLoaded = true; },
	});
	await after.settle(after.controller.recover(after.player));
	assert.equal(homeLoaded, true);
	assertClean(after);
});

test("an interrupted barrier write is repaired using the persistent air-only journal", async () => {
	const loading = deferred();
	const before = harness({ createArea(id) { if (id.includes("_section_")) return loading.promise; } });
	void before.controller.start(before.player, 0, 1, 0, 1);
	await before.flush();
	const saved = before.record();
	saved.pendingBlock = { dimensionId: "minecraft:overworld", location: { x: 8, y: 319, z: 8 } };
	const after = harness({ properties: [["chunk_generator:recovery", JSON.stringify(saved)]], location: before.player.location,
		getBlock(location) { if (location.x === 8 && location.y === 319 && location.z === 8) return "minecraft:barrier"; },
	});
	assert.equal(after.dimension.getBlock({ x: 8, y: 319, z: 8 }).typeId, "minecraft:air");
	await after.settle(after.controller.recover(after.player));
	assertClean(after);
});

test("initial journal write failure prevents all protection changes and teleports", async () => {
	const h = harness({ save(key, value) { if (value !== undefined) throw new Error("Storage unavailable"); } });
	assert.equal((await h.run()).status, "failed");
	assert.equal(h.events.some(event => event.kind === "teleport" || event.kind.startsWith("effect-")), false);
	assertClean(h);
});

test("malformed persistent recovery blocks a new generation without discarding saved data", async () => {
	const h = harness({ properties: [["chunk_generator:recovery", "{invalid"]] });
	assert.equal((await h.run()).status, "refused");
	assert.equal(h.properties.get("chunk_generator:recovery"), "{invalid");
	assert.equal(h.events.some(event => event.kind === "teleport"), false);
});

test("legacy generation flags and owned areas are reset while unrelated areas are preserved", async () => {
	const h = harness({ generating: true, areas: [
		["chunk_generator:section_1", { identifier: "chunk_generator:section_1", isFullyLoaded: true }],
		["another_feature:area", { identifier: "another_feature:area", isFullyLoaded: true }],
	] });
	assert.equal(h.player.getDynamicProperty("chunk_generator:generating"), false);
	assert.equal(h.areas.has("chunk_generator:section_1"), false);
	assert.equal(h.areas.has("another_feature:area"), true);
	assert.equal((await h.run()).status, "complete");
	h.areas.delete("another_feature:area");
	assertClean(h);
});

test("a silently ignored block write is not reported as a processed chunk", async () => {
	const h = harness({ setPermutation(block, next) { if (next.type.id === "minecraft:barrier") return false; } });
	const result = await h.run();
	assert.equal(result.processed, 0);
	assert.equal(result.failed, 1);
	assertClean(h);
});

test("restart rechecks a saved successful return because player data can have been saved separately", async () => {
	let failRemoval = true;
	const before = harness({ removeArea() { if (failRemoval) throw new Error("Retain a recovery record"); } });
	await before.run();
	assert.equal(before.record().returnPending, false);
	const after = harness({ properties: [...before.properties], location: { x: 0, y: 324, z: 0 } });
	assert.equal(after.record().returnPending, true);
	await after.settle(after.controller.recover(after.player));
	assertClean(after);
});

test("restoring an interrupted block is attempted even when reloading the return area fails", async () => {
	const loading = deferred();
	const before = harness({ createArea(id) { if (id.includes("_section_")) return loading.promise; } });
	void before.controller.start(before.player, 0, 1, 0, 1);
	await before.flush();
	const saved = before.record();
	saved.pendingBlock = { dimensionId: "minecraft:overworld", location: { x: 8, y: 319, z: 8 } };
	let homeFails = true, blockLoaded = false;
	const after = harness({ properties: [["chunk_generator:recovery", JSON.stringify(saved)]], location: before.player.location,
		getBlock(location) {
			if (location.x > 90 && homeFails) return null;
			if (location.x === 8 && location.y === 319 && location.z === 8) return blockLoaded ? "minecraft:barrier" : null;
		},
		createArea(id) { if (id.endsWith("_home") && homeFails) throw new Error("Home load failed"); if (id.endsWith("_repair")) blockLoaded = true; },
	});
	await after.settle(after.controller.recover(after.player));
	assert.equal(after.record().pendingBlock, null);
	assert.equal(after.record().returnPending, true);
	assert.equal(after.dimension.getBlock({ x: 8, y: 319, z: 8 }).typeId, "minecraft:air");
	homeFails = false;
	await after.settle(after.controller.recover(after.player));
	assertClean(after);
});

test("canceling after one section prevents the next section from starting", async () => {
	const h = harness();
	const originalSend = h.player.sendMessage;
	h.player.sendMessage = function(text) {
		originalSend.call(this, text);
		if (text.includes("Section 1/2:") && text.includes("total")) h.controller.stop(this);
	};
	const result = await h.run(0, 9, 0, 1);
	assert.equal(result.processed, 8);
	assert.equal(result.successful, 1);
	assert.equal(result.notStarted, 1);
	assert.equal(result.status, "cancelled");
	assertClean(h);
});

test("a different external effect grant is preserved during recovery", async () => {
	const loading = deferred();
	const h = harness({ createArea(id) { if (id.includes("_section_")) return loading.promise; } });
	const work = h.controller.start(h.player, 0, 1, 0, 1);
	await h.flush();
	h.effects.set(RESISTANCE, { amplifier: 5, expires: 5000, showParticles: true });
	await h.step();
	await h.settle(work);
	loading.resolve();
	await h.flush();
	assert.equal(h.player.getEffect(RESISTANCE).amplifier, 5);
	assert.equal(h.effects.get(RESISTANCE).showParticles, true);
	assert.equal(h.player.getEffect(SLOW_FALLING), undefined);
	assert.equal(h.record(), undefined);
});

test("failed cleanup of a legacy area without a journal is retried before allowing generation", async () => {
	let fail = true;
	const h = harness({ areas: [["chunk_generator:section_1", { identifier: "chunk_generator:section_1" }]],
		removeArea() { if (fail) throw new Error("Legacy removal failed"); },
	});
	assert.equal((await h.run()).status, "refused");
	assert.equal(h.events.some(event => event.kind === "teleport"), false);
	fail = false;
	assert.equal((await h.run()).status, "complete");
	assertClean(h);
});

test("a transient area-query failure at startup can recover without a permanent stale lock", async () => {
	let fail = true;
	const h = harness({ queryAreas() { if (fail) throw new Error("Area query failed"); } });
	assert.equal((await h.run()).status, "refused");
	fail = false;
	assert.equal((await h.run()).status, "complete");
	assertClean(h);
});
