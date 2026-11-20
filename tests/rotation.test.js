import test from "node:test";
import assert from "node:assert/strict";
import { deferred, harness } from "./harness.js";

function clampPitch(rotation) {
	return { ...rotation, x: Math.max(-89, Math.min(89, rotation.x)) };
}
function clean(h) {
	assert.deepEqual(h.player.location, h.origin);
	assert.equal(h.player.mode, "Survival");
	assert.equal(h.record(), undefined);
	assert.equal(h.effects.size, 0);
	assert.equal(h.areas.size, 0);
	assert.equal(h.player.getDynamicProperty("chunk_generator:generating"), false);
}

test("the reported 89.475-to-89-degree adjustment during section two does not cancel 884 chunks", async () => {
	let movedMouse = false;
	const h = harness({ rotationResult: clampPitch,
		createArea(id, settings, h) {
			if (id.endsWith("_section_2")) return new Promise(resolve => h.system.runTimeout(resolve, 3));
		},
		tick(h) {
			if (!movedMouse && [...h.areas.keys()].some(id => id.endsWith("_section_2"))) {
				movedMouse = true;
				h.player.location.y = 322.865;
				h.player.rotation = { x: 89.475, y: -10.984 };
			}
		},
	});
	const result = await h.run(-46, -20, -5, 29);
	assert.equal(movedMouse, true);
	assert.equal(result.status, "complete");
	assert.equal(result.processed, 884);
	assert.equal(result.successful, 20);
	assert.ok(h.events.some(event => event.kind === "teleport" && event.settings.rotation.x === 89.475));
	assert.equal(h.events.some(event => event.kind === "warning" && event.text.includes("anchor_restore_failed")), false);
	clean(h);
});

test("mouse input changing the returned camera angle does not leave a correct return pending", async () => {
	let mouseActive = false;
	const h = harness({
		createArea(id) { if (id.includes("_section_")) mouseActive = true; },
		rotationResult(rotation) { return mouseActive ? { x: rotation.x + 1, y: rotation.y + 30 } : rotation; },
	});
	const result = await h.run(0, 9, 0, 1);
	assert.equal(result.status, "complete");
	assert.equal(result.processed, 9);
	assert.notDeepEqual(h.player.rotation, { x: 12, y: -37 });
	assert.ok(h.events.some(event => event.kind === "teleport" && event.location.y === h.origin.y && event.settings.rotation.y === -37));
	clean(h);
});

test("a real position mismatch still keeps recovery and protections even when angles are adjusted", async () => {
	let denyReturn = true;
	const h = harness({ rotationResult: clampPitch,
		teleport(location, settings) { if (denyReturn && settings.checkForBlocks) return false; },
	});
	const result = await h.run();
	assert.equal(result.recoveryPending, true);
	assert.equal(h.record().returnPending, true);
	assert.equal(h.effects.size, 2);
	denyReturn = false;
	await h.settle(h.controller.recover(h.player));
	clean(h);
});

test("restart recovers an old pending-load journal even if the stored angle is normalized", async () => {
	const loading = deferred();
	const before = harness({ createArea(id) { if (id.includes("_section_")) return loading.promise; } });
	before.player.rotation = { x: 89.475, y: -10.984 };
	const work = before.controller.start(before.player, 0, 1, 0, 1);
	await before.flush();
	// Reproduce the foreground journal left by 1.0.4 after a successful return
	// while its native area promise was still pending.
	const saved = before.record();
	saved.returnPending = false;
	saved.flagPending = false;
	saved.effects.forEach(effect => { effect.owned = false; });
	saved.areaIds = saved.areaIds.filter(id => id.includes("_section_"));
	before.controller.stop(before.player);
	assert.equal((await before.settle(work)).recoveryPending, true);
	const after = harness({ properties: [["chunk_generator:recovery", JSON.stringify(saved)]], location: before.player.location, rotationResult: clampPitch });
	assert.ok(after.record());
	await after.settle(after.controller.recover(after.player));
	assert.equal(after.player.rotation.x, 89);
	clean(after);
});
