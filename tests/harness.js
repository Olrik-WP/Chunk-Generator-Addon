import { createGenerator } from "../src/scripts/generation.js";

export function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

export function harness(options = {}) {
	const properties = new Map(options.properties);
	const areas = new Map(options.areas);
	const blocks = new Map();
	const events = [];
	const messages = [];
	const timers = new Map();
	const effects = new Map();
	const origin = options.origin ?? { x: 100.5, y: 70, z: 100.5 };
	let timerId = 0;
	const h = { options, properties, areas, blocks, events, messages, effects, origin };
	const system = {
		currentTick: 0,
		runTimeout(callback, ticks = 1) { const id = ++timerId; timers.set(id, { at: system.currentTick + ticks, callback }); return id; },
		clearRun(id) { timers.delete(id); },
	};
	const dimensions = new Map();
	function dimension(id, range = { min: -64, max: 320 }) {
		const result = {
			id, heightRange: range,
			getBlock(location) {
				if (location.y < range.min || location.y >= range.max) throw new Error("Block outside dimension bounds");
				const override = options.getBlock?.(location, id, h);
				if (override === null) return undefined;
				const key = `${id}:${location.x},${location.y},${location.z}`;
				if (!blocks.has(key)) {
					const nearHome = Math.abs(location.x - origin.x) <= 1 && Math.abs(location.z - origin.z) <= 1;
					let permutation = { type: { id: override ?? (nearHome && location.y === Math.floor(origin.y - 0.01) ? "minecraft:stone" : "minecraft:air") }, getAllStates() { return options.blockStates?.(location, id, h) ?? {}; } };
					const block = {
						location: { ...location }, dimension: result, payload: { example: "container contents" },
						get typeId() { return permutation.type.id; },
						get permutation() { return permutation; },
						setPermutation(next) {
							events.push({ kind: "block", location: { ...location }, from: permutation.type.id, to: next.type.id });
							if (options.setPermutation?.(block, next, h) === false) return;
							permutation = next;
						},
					};
					blocks.set(key, block);
				}
				return blocks.get(key);
			},
		};
		dimensions.set(id, result);
		return result;
	}
	const initialDimension = dimension(options.dimensionId ?? "minecraft:overworld", options.heightRange);
	const playerProperties = new Map([["chunk_generator:generating", options.generating ?? false]]);
	function getEffect(typeId) {
		const value = effects.get(typeId);
		if (!value) return undefined;
		const duration = value.expires < 0 ? -1 : value.expires - system.currentTick;
		if (duration <= 0 && value.expires >= 0) { effects.delete(typeId); return undefined; }
		return { typeId, amplifier: value.amplifier, duration, isValid: true };
	}
	for (const [typeId, effect] of Object.entries(options.effects ?? {})) effects.set(typeId, {
		amplifier: effect.amplifier, expires: effect.duration, showParticles: effect.showParticles ?? true,
	});
	const player = {
		id: "player-1", name: "Tester", isValid: true, dimension: initialDimension,
		location: { ...(options.location ?? origin) }, rotation: { x: 12, y: -37 }, velocity: { x: 0, y: 0, z: 0 },
		mode: "Survival", getGameMode() { return this.mode; },
		setGameMode() { throw new Error("Game mode must never be changed"); },
		extinguishFire() { events.push({ kind: "extinguish" }); },
		getRotation() { return { ...this.rotation }; }, getVelocity() { return { ...this.velocity }; },
		getAABB() {
			const height = options.playerHeight ?? 1.8;
			return { center: { x: this.location.x, y: this.location.y + height / 2, z: this.location.z }, extent: { x: 0.3, y: height / 2, z: 0.3 } };
		},
		getAllBlocksStandingOn() {
			if (options.standingOn) return options.standingOn(h);
			const block = this.dimension.getBlock({ x: Math.floor(this.location.x), y: Math.floor(this.location.y - 0.01), z: Math.floor(this.location.z) });
			return block && block.typeId !== "minecraft:air" ? [block] : [];
		},
		tryTeleport(location, settings) {
			events.push({ kind: "collision-probe", location, settings, protected: !!getEffect("minecraft:resistance") && !!getEffect("minecraft:slow_falling") });
			if (options.collisionProbe?.(location, settings, h) === false) return false;
			this.location = { ...location }; this.dimension = settings.dimension;
			this.rotation = { ...(options.rotationResult?.({ ...settings.rotation }, location, h) ?? settings.rotation) };
			this.velocity = { x: 0, y: 0, z: 0 };
			return true;
		},
		getDynamicProperty(key) { if (!this.isValid) throw new Error("Invalid player"); return playerProperties.get(key); },
		setDynamicProperty(key, value) { if (!this.isValid) throw new Error("Invalid player"); playerProperties.set(key, value); },
		getEffect,
		addEffect(typeId, duration, settings) {
			if (!this.isValid) throw new Error("Invalid player");
			events.push({ kind: "effect-add", typeId, duration, ...settings });
			if (options.addEffect?.(typeId, duration, settings, h) === false) return;
			effects.set(typeId, { ...settings, expires: system.currentTick + duration });
		},
		removeEffect(typeId) {
			if (!this.isValid) throw new Error("Invalid player");
			events.push({ kind: "effect-remove", typeId });
			options.removeEffect?.(typeId, h);
			return effects.delete(typeId);
		},
		teleport(location, settings) {
			if (!this.isValid) throw new Error("Invalid player");
			events.push({ kind: "teleport", location: { ...location }, settings, protected: !!getEffect("minecraft:resistance") && !!getEffect("minecraft:slow_falling") });
			if (options.teleport?.(location, settings, h) === false) return;
			this.location = { ...location }; this.dimension = settings.dimension;
			this.rotation = { ...(options.rotationResult?.({ ...settings.rotation }, location, h) ?? settings.rotation) };
			if (settings.keepVelocity === false) this.velocity = { x: 0, y: 0, z: 0 };
		},
		sendMessage(text) { if (!this.isValid) throw new Error("Invalid player"); messages.push(text); },
	};
	const manager = {
		hasCapacity(settings) { return options.hasCapacity?.(settings, h) ?? true; },
		async createTickingArea(id, settings) {
			events.push({ kind: "area-create", id, settings });
			if (areas.has(id)) throw new Error("Duplicate ticking area");
			areas.set(id, { identifier: id, isFullyLoaded: false, ...settings });
			await options.createArea?.(id, settings, h);
			if (areas.has(id)) areas.get(id).isFullyLoaded = options.fullyLoaded !== false;
		},
		hasTickingArea(id) { return areas.has(id); },
		getTickingArea(id) { return areas.get(id); },
		getAllTickingAreas() { options.queryAreas?.(h); return [...areas.values()]; },
		removeTickingArea(id) { events.push({ kind: "area-remove", id }); options.removeArea?.(id, h); areas.delete(id); },
	};
	const world = {
		tickingAreaManager: manager,
		getDynamicProperty(key) { return properties.get(key); },
		setDynamicProperty(key, value) {
			options.save?.(key, value, h);
			if (value === undefined) properties.delete(key); else properties.set(key, value);
		},
		getDimension(id) { return dimensions.get(id) ?? dimension(id); },
		getAllPlayers() { return player.isValid ? [player] : []; },
	};
	const logger = { log(text) { events.push({ kind: "log", text }); }, warn(text) { events.push({ kind: "warning", text }); } };
	const BlockPermutation = { resolve: typeId => ({ type: { id: typeId }, getAllStates() { return {}; } }) };
	Object.assign(h, { world, system, player, dimension: initialDimension, logger, BlockPermutation });
	h.controller = createGenerator({ world, system, BlockPermutation, logger });
	h.controller.initialize();
	h.record = () => { const raw = properties.get("chunk_generator:recovery"); return raw ? JSON.parse(raw) : undefined; };
	h.flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
	h.step = async (count = 1) => {
		for (let i = 0; i < count; i++) {
			system.currentTick++;
			options.tick?.(h);
			h.controller.tick();
			for (const [id, timer] of [...timers]) if (timer.at <= system.currentTick) { timers.delete(id); timer.callback(); }
			await h.flush();
		}
	};
	h.settle = async (promise, maxTicks = 3000) => {
		let finished = false, value, failure;
		promise.then(result => { finished = true; value = result; }, error => { finished = true; failure = error; });
		await h.flush();
		for (let i = 0; !finished && i < maxTicks; i++) await h.step();
		if (!finished) throw new Error(`Test did not settle in ${maxTicks} ticks`);
		if (failure) throw failure;
		return value;
	};
	h.run = (...bounds) => h.settle(h.controller.start(player, ...(bounds.length ? bounds : [0, 1, 0, 1])));
	return h;
}
