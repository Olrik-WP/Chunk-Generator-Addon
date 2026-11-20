import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./harness.js";

function floor(typeId) {
	return (location, dimensionId, h) => location.y === Math.floor(h.origin.y - 0.01) &&
		Math.abs(location.x - h.origin.x) < 3 && Math.abs(location.z - h.origin.z) < 3 ? typeId : undefined;
}
function clean(h) {
	assert.deepEqual(h.player.location, h.origin);
	assert.equal(h.record(), undefined);
	assert.equal(h.effects.size, 0);
	assert.equal(h.areas.size, 0);
	assert.equal(h.player.mode, "Survival");
	assert.equal(h.player.getDynamicProperty("chunk_generator:generating"), false);
}

for (const ground of ["minecraft:grass_block", "minecraft:grass", "minecraft:dirt", "minecraft:oak_log"]) {
	test(`engine-supported normal ground is accepted without a block-ID whitelist: ${ground}`, async () => {
		const h = harness({ getBlock: floor(ground) });
		assert.equal((await h.run()).status, "complete");
		const probe = h.events.find(event => event.kind === "collision-probe");
		assert.equal(probe.protected, true);
		assert.equal(probe.settings.checkForBlocks, true);
		clean(h);
	});
}

test("a normal two-block-high house and a wall touching the real collision bounds are accepted", async () => {
	const h = harness({ origin: { x: 100.7, y: 70, z: 100.5 }, getBlock(location) {
		if (location.x === 101 || location.y === 72) return "minecraft:oak_planks";
	} });
	assert.equal((await h.run()).status, "complete");
	clean(h);
});

test("a supported ledge does not require every corner voxel beneath the player to be solid", async () => {
	const h = harness({ origin: { x: 100.9, y: 70, z: 100.5 }, getBlock(location) {
		if (location.x === 101 && location.y === 69) return "minecraft:air";
	} });
	assert.equal((await h.run()).status, "complete");
	clean(h);
});

for (const [ground, y] of [["minecraft:oak_slab", 70.5], ["minecraft:oak_stairs", 70.5], ["minecraft:white_carpet", 70.0625]]) {
	test(`a fractional standing height on ${ground} preserves the exact return`, async () => {
		const h = harness({ origin: { x: 100.5, y, z: 100.5 }, getBlock: floor(ground) });
		assert.equal((await h.run()).status, "complete");
		assert.equal(h.player.location.y, y);
		clean(h);
	});
}

test("a passable decoration in a body voxel is delegated to Minecraft's collision check", async () => {
	const h = harness({ getBlock(location) { if (location.x === 100 && location.y === 70 && location.z === 100) return "minecraft:torch"; } });
	assert.equal((await h.run()).status, "complete");
	clean(h);
});

test("a 918-chunk generation can start inside a house", async () => {
	const h = harness({ origin: { x: 100.7, y: 70, z: 100.5 }, getBlock(location) {
		if (location.x > 90 && location.y === 69) return "minecraft:grass_block";
		if (location.x > 90 && location.y === 72) return "minecraft:oak_planks";
	} });
	const result = await h.run(-48, -21, -36, -2);
	assert.equal(result.total, 918);
	assert.equal(result.processed, 918);
	assert.equal(result.successful, 20);
	clean(h);
});

for (const hazard of ["minecraft:lava", "minecraft:water", "minecraft:fire", "minecraft:powder_snow", "minecraft:cactus", "minecraft:magma"]) {
	test(`hazardous standing support is refused with the actual block and coordinates: ${hazard}`, async () => {
		const h = harness({ getBlock: floor(hazard) });
		assert.equal((await h.run()).status, "failed");
		assert.ok(h.messages.some(text => text.includes(hazard) && text.includes("100.000, 69.000, 100.000")));
		assert.equal(h.events.some(event => event.kind === "teleport" || event.kind === "collision-probe"), false);
		clean(h);
	});
}

test("missing support is refused with the measured block and movement instead of a generic house warning", async () => {
	const h = harness({ getBlock: floor("minecraft:grass_block"), standingOn() { return []; } });
	assert.equal((await h.run()).status, "failed");
	assert.ok(h.messages.some(text => text.includes("below feet=minecraft:grass_block") && text.includes("detected supports=none")));
	clean(h);
});

test("a positive vertical velocity is refused before movement", async () => {
	const h = harness();
	h.player.velocity.y = 0.3;
	assert.equal((await h.run()).status, "failed");
	assert.ok(h.messages.some(text => text.includes("vertical velocity=0.300")));
	clean(h);
});

test("an engine collision rejection prevents remote movement and cleans the added effects", async () => {
	const h = harness({ collisionProbe() { return false; } });
	assert.equal((await h.run()).status, "failed");
	assert.ok(h.messages.some(text => text.includes("Bedrock rejected the return collision check")));
	assert.equal(h.events.some(event => event.kind === "teleport"), false);
	clean(h);
});

test("a newly obstructed return is rejected by native collision validation and remains recoverable", async () => {
	let obstructed = false;
	const h = harness({
		createArea(id) { if (id.includes("_section_")) obstructed = true; },
		teleport(location, options) { if (obstructed && options.checkForBlocks) return false; },
	});
	assert.equal((await h.run()).recoveryPending, true);
	assert.equal(h.record().returnPending, true);
	assert.equal(h.effects.size, 2);
	obstructed = false;
	await h.settle(h.controller.recover(h.player));
	clean(h);
});

test("support block-state changes prevent return even when the block ID stays the same", async () => {
	let changed = false;
	const h = harness({ getBlock: floor("minecraft:oak_slab"),
		blockStates(location) { return location.y === 69 ? { "minecraft:vertical_half": changed ? "top" : "bottom" } : {}; },
		createArea(id) { if (id.includes("_section_")) changed = true; },
	});
	assert.equal((await h.run()).recoveryPending, true);
	assert.ok(h.events.some(event => event.kind === "warning" && event.text.includes("support or its neighbor changed")));
	changed = false;
	await h.settle(h.controller.recover(h.player));
	clean(h);
});

test("a pre-1.0.3 recovery journal is still restored without discarding it", async () => {
	let failed = true;
	const before = harness({ removeArea() { if (failed) throw new Error("Hold the journal"); } });
	await before.run();
	const saved = before.record();
	delete saved.origin.landing;
	const after = harness({ properties: [["chunk_generator:recovery", JSON.stringify(saved)]], location: { x: 0, y: 324, z: 0 } });
	await after.settle(after.controller.recover(after.player));
	clean(after);
});
