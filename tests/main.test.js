import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { deferred } from "./harness.js";

function app() {
	const commands = new Map(), forms = [], calls = [], properties = new Map();
	let running = false;
	class Form {
		constructor() { this.labels = []; this.response = deferred(); forms.push(this); }
		title(text) { this.heading = text; return this; }
		body(text) { this.text = text; return this; }
		button(text) { this.labels.push(text); return this; }
		button1(text) { return this.button(text); }
		button2(text) { return this.button(text); }
		textField() { return this; }
		show() { return this.response.promise; }
	}
	const controller = {
		initialize() {}, recover() {}, tick() {}, onLeave() {},
		start(...args) { calls.push({ kind: "start", args }); return Promise.resolve(); },
		stop() { calls.push({ kind: "stop" }); running = false; },
		isGenerating() { return running; },
	};
	const player = {
		typeId: "minecraft:player", isValid: true, location: { x: 100, y: 70, z: 100 },
		getDynamicProperty(key) { return properties.get(key); },
		setDynamicProperty(key, value) { properties.set(key, value); },
		sendMessage() {},
	};
	const event = () => ({ subscribe() {} });
	const context = {
		world: { afterEvents: { worldLoad: event(), playerSpawn: event(), playerLeave: event() } },
		system: { run(callback) { callback(); }, runInterval() {}, beforeEvents: { startup: { subscribe(callback) {
			callback({ customCommandRegistry: { registerCommand(metadata, callback) { commands.set(metadata.name, { metadata, callback }); } } });
		} } } },
		createGenerator() { return controller; }, BlockPermutation: {},
		CommandPermissionLevel: { Any: 0 }, CustomCommandParamType: { Integer: "integer" },
		ActionFormData: Form, ModalFormData: Form, MessageFormData: Form, console,
	};
	const source = readFileSync(new URL("../src/scripts/main.js", import.meta.url), "utf8")
		.replace(/import\s*\{[\s\S]*?\}\s*from\s*"[^"]+";\s*/g, "");
	vm.runInNewContext(source, context);
	return { commands, forms, calls, player, properties, setRunning(value) { running = value; } };
}

test("all four original commands are registered, and the reference coordinates reach the controller unchanged", () => {
	const h = app();
	assert.deepEqual([...h.commands.keys()], ["chunk_generator:gui", "chunk_generator:generate", "chunk_generator:radius", "chunk_generator:stop"]);
	h.commands.get("chunk_generator:generate").callback({ sourceEntity: h.player }, -290, -376, -24, -70);
	assert.deepEqual(h.calls[0].args.slice(1), [-19, -1, -24, -4]);
});

test("the original GUI buttons remain available and a stale form uses the current generation state", async () => {
	const h = app();
	h.commands.get("chunk_generator:gui").callback({ sourceEntity: h.player });
	assert.deepEqual(h.forms[0].labels, ["Set Coordinates", "Extend to My Position", "Clear Selection", "Generate"]);
	h.setRunning(true);
	h.forms[0].response.resolve({ selection: 3, canceled: false });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(h.calls.at(-1).kind, "stop");
	assert.equal(h.forms.length, 1);
});

test("radius selection keeps its previous coordinate convention and refuses negative input", () => {
	const h = app();
	const command = h.commands.get("chunk_generator:radius").callback;
	command({ sourceEntity: h.player }, -32);
	assert.equal(h.properties.has("chunk_generator:selection"), false);
	command({ sourceEntity: h.player }, 32);
	assert.deepEqual(JSON.parse(h.properties.get("chunk_generator:selection")), { minX: 84, maxX: 116, minZ: 84, maxZ: 116 });
});
