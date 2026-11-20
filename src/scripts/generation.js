const CHUNK_SIZE = 16;
const SECTION_CHUNKS = 8;
const GENERATING_PROPERTY = "chunk_generator:generating";
const RECOVERY_PROPERTY = "chunk_generator:recovery";
const AREA_PREFIX = "chunk_generator:job_";
const EFFECT_TICKS = 1200;
const EFFECT_RESERVE = 100;
const LOAD_TIMEOUT = 600;
const EFFECTS = [
	{ typeId: "minecraft:resistance", amplifier: 4 },
	{ typeId: "minecraft:slow_falling", amplifier: 0 },
];

// Stable 2.8.0 has no general, stable block collision-shape query. Require a
// known full, harmless support block instead of treating every non-air block
// (slabs, cactus, containers, custom blocks...) as a safe place to return.
const SAFE_SUPPORT = new Set([
	"stone", "granite", "polished_granite", "diorite", "polished_diorite",
	"andesite", "polished_andesite", "cobblestone", "mossy_cobblestone",
	"deepslate", "cobbled_deepslate", "polished_deepslate", "deepslate_bricks",
	"deepslate_tiles", "tuff", "calcite", "grass_block", "dirt", "coarse_dirt",
	"rooted_dirt", "clay", "mud", "packed_mud", "mud_bricks", "bedrock",
	"stonebrick", "stone_bricks", "brick_block", "bricks", "sandstone",
	"red_sandstone", "quartz_block", "netherrack", "basalt", "smooth_basalt",
	"blackstone", "polished_blackstone", "nether_brick", "nether_bricks",
	"red_nether_brick", "red_nether_bricks", "end_stone", "end_bricks",
	"end_stone_bricks", "obsidian", "crying_obsidian", "iron_block",
	"gold_block", "diamond_block", "emerald_block", "netherite_block",
	"coal_block", "copper_block", "prismarine", "dark_prismarine", "planks",
	"oak_planks", "spruce_planks", "birch_planks", "jungle_planks",
	"acacia_planks", "dark_oak_planks", "mangrove_planks", "cherry_planks",
	"bamboo_planks", "crimson_planks", "warped_planks", "pale_oak_planks",
].map(id => `minecraft:${id}`));

class GenerationCancelled extends Error {}

function validRecord(value) {
	const vector = (point, axes) => point && axes.every(axis => Number.isFinite(point[axis]));
	const original = value?.origin;
	return value?.version === 1 && typeof value.playerId === "string" && value.playerId.length > 0 &&
		typeof value.jobId === "string" && value.jobId.startsWith(AREA_PREFIX) &&
		original?.gameMode === "Survival" && typeof original.dimensionId === "string" &&
		vector(original.location, ["x", "y", "z"]) && vector(original.rotation, ["x", "y"]) &&
		typeof value.returnPending === "boolean" && typeof value.travelStarted === "boolean" && typeof value.flagPending === "boolean" &&
		Array.isArray(value.areaIds) && value.areaIds.every(id => typeof id === "string" &&
			(id.startsWith(AREA_PREFIX) || id.startsWith("chunk_generator:section_"))) &&
		Array.isArray(value.effects) && value.effects.length === EFFECTS.length &&
		value.effects.every((effect, index) => effect.typeId === EFFECTS[index].typeId &&
			effect.amplifier === EFFECTS[index].amplifier && typeof effect.owned === "boolean" &&
			(effect.original === null || (Number.isFinite(effect.original?.amplifier) && Number.isFinite(effect.original?.duration)))) &&
		(value.pendingBlock === null || (typeof value.pendingBlock?.dimensionId === "string" &&
			vector(value.pendingBlock.location, ["x", "y", "z"])));
}

/** Minecraft services are injected so the actual controller can be tested without BDS. */
export function createGenerator({ world, system, BlockPermutation, logger = console }) {
	let ready = false;
	let record;
	let storageError;
	let active;
	let recovering = false;
	let sequence = 0;
	let barrier;
	let resourcesScanned = false;
	const pendingAreas = new Set();
	const staleAreas = new Set();

	const logError = (context, error) => logger.warn(`[Chunk Generator] ${context}: ${error}`);
	function message(player, text) {
		try { if (player?.isValid) player.sendMessage(text); }
		catch (error) { logError("Sending a message", error); }
	}
	function save() {
		world.setDynamicProperty(RECOVERY_PROPERTY, JSON.stringify(record));
	}
	function attempt(context, action) {
		try { return action(); }
		catch (error) { logError(context, error); return false; }
	}
	function onlinePlayer() {
		return world.getAllPlayers().find(player => player.id === record?.playerId && player.isValid);
	}
	function finishRecovery() {
		if (!record || record.returnPending || record.flagPending || record.pendingBlock ||
			record.areaIds.length || pendingAreas.size || record.effects.some(effect => effect.owned)) return false;
		world.setDynamicProperty(RECOVERY_PROPERTY, undefined);
		record = undefined;
		return true;
	}
	function removeArea(id) {
		if (pendingAreas.has(id)) return false;
		const manager = world.tickingAreaManager;
		if (manager.hasTickingArea(id)) manager.removeTickingArea(id);
		if (manager.hasTickingArea(id)) throw new Error(`Ticking area still present: ${id}`);
		staleAreas.delete(id);
		if (record?.areaIds.includes(id)) {
			record.areaIds = record.areaIds.filter(value => value !== id);
			save();
		}
		return true;
	}
	function removeAreas() {
		for (const id of new Set([...(record?.areaIds ?? []), ...staleAreas])) attempt(`Removing ${id}`, () => removeArea(id));
	}
	function snapshotEffect(player, spec) {
		const effect = player.getEffect(spec.typeId);
		return effect ? { amplifier: effect.amplifier, duration: effect.duration } : null;
	}
	function adequate(effect, spec) {
		return effect && effect.amplifier >= spec.amplifier &&
			(effect.duration < 0 || effect.duration > EFFECT_RESERVE);
	}
	function protect(player) {
		for (const effect of record.effects) {
			const current = player.getEffect(effect.typeId);
			if (!effect.owned && current) {
				// Never overwrite an existing effect: stable Effect does not expose
				// showParticles, so copying it back would not preserve all parameters.
				if (!adequate(current, effect)) throw new Error(`Existing ${effect.typeId} is too weak or expires soon; it was left unchanged.`);
				continue;
			}
			if (effect.owned && current &&
				(current.amplifier !== effect.amplifier || current.duration < 0 || current.duration > EFFECT_TICKS)) {
				effect.owned = false; // Preserve an externally replaced effect.
				save();
				throw new Error(`${effect.typeId} was changed by another source.`);
			}
			if (!current || current.duration < EFFECT_TICKS / 2) {
				effect.owned = true;
				save(); // Record ownership before applying an effect, including partial failures.
				player.addEffect(effect.typeId, EFFECT_TICKS, { amplifier: effect.amplifier, showParticles: false });
			}
			if (!adequate(player.getEffect(effect.typeId), effect)) throw new Error(`Protection could not be verified: ${effect.typeId}`);
		}
	}
	function restoreEffects(player) {
		for (const effect of record.effects) {
			if (!effect.owned) continue;
			attempt(`Restoring ${effect.typeId}`, () => {
				const current = player.getEffect(effect.typeId);
				// Initial effects were never overwritten. Only remove our own
				// finite grant; preserve visibly different grants from other sources.
				if (current && current.amplifier === effect.amplifier && current.duration >= 0 && current.duration <= EFFECT_TICKS) {
					player.removeEffect(effect.typeId);
					if (player.getEffect(effect.typeId)) throw new Error("Effect removal was not applied");
				}
				effect.owned = false;
				save();
			});
		}
	}
	async function restoreAfterLanding(player) {
		if (!record.effects.some(effect => effect.owned)) return;
		try { await new Promise(resolve => system.runTimeout(resolve, 1)); }
		catch (error) { logError("Waiting for the landing tick", error); }
		if (player.isValid) restoreEffects(player);
	}
	function clearBody(dimension, location, requireSupport) {
		const { min, max } = dimension.heightRange;
		if (location.y < min + 2) return false;
		if (location.y > max + 1) return !requireSupport; // Outside the block volume, not a safe landing.
		for (let x = Math.floor(location.x - 0.31); x <= Math.floor(location.x + 0.31); x++) {
			for (let z = Math.floor(location.z - 0.31); z <= Math.floor(location.z + 0.31); z++) {
				for (let y = Math.floor(location.y + 0.01); y <= Math.floor(location.y + 1.81); y++) {
					if (y >= max) continue;
					if (dimension.getBlock({ x, y, z })?.typeId !== "minecraft:air") return false;
				}
				if (requireSupport && !SAFE_SUPPORT.has(dimension.getBlock({ x, y: Math.floor(location.y - 0.01), z })?.typeId)) return false;
			}
		}
		return true;
	}
	function verifyTeleport(player, location, dimension, rotation) {
		const actual = player.location;
		const facing = player.getRotation();
		const angleDifference = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
		if (player.dimension.id !== dimension.id ||
			["x", "y", "z"].some(axis => Math.abs(actual[axis] - location[axis]) > 0.05) ||
			angleDifference(facing.x, rotation.x) > 0.1 || angleDifference(facing.y, rotation.y) > 0.1) {
			throw new Error("Teleport position, dimension or orientation did not match the requested return");
		}
	}
	function teleport(player, location, dimension, rotation, checkForBlocks) {
		player.teleport(location, { dimension, rotation, checkForBlocks, keepVelocity: false });
		verifyTeleport(player, location, dimension, rotation);
	}
	function returnPlayer(player) {
		if (!record.returnPending) return true;
		if (!player?.isValid) return false;
		const origin = record.origin;
		const dimension = world.getDimension(origin.dimensionId);
		if (!clearBody(dimension, origin.location, true)) throw new Error("Original position is obstructed, unsafe, or not loaded; recovery retained");
		teleport(player, origin.location, dimension, origin.rotation, true);
		attempt("Extinguishing fire after return", () => player.extinguishFire());
		record.returnPending = false;
		save();
		return true;
	}
	function emergencyReturn(player) {
		if (!record?.returnPending || !player?.isValid) return;
		if (attempt("Emergency return", () => returnPlayer(player))) return;
		// If the original landing was obstructed, buy time above its block
		// volume, keeping protection and the exact-return journal in place.
		attempt("Emergency relocation", () => {
			const dimension = world.getDimension(record.origin.dimensionId);
			teleport(player, { ...record.origin.location, y: dimension.heightRange.max + 4 }, dimension, record.origin.rotation, false);
		});
	}
	function cancel(job, reason, status = "cancelled") {
		if (job.reason) return;
		job.reason = reason;
		job.status = status;
		job.resolveCancellation(new GenerationCancelled(reason));
		emergencyReturn(job.player);
	}
	function check(job) {
		if (!job.player.isValid) cancel(job, "Player disconnected");
		else if (job.player.getGameMode() !== record.origin.gameMode) cancel(job, "Player game mode changed externally");
		else if (!job.player.getDynamicProperty(GENERATING_PROPERTY)) cancel(job, "Canceled by player");
		if (job.reason) throw new GenerationCancelled(job.reason);
	}
	async function pause(job) {
		await new Promise(resolve => system.runTimeout(resolve, 1));
		check(job);
	}
	async function loadArea(id, options, job) {
		if (!record.areaIds.includes(id)) { record.areaIds.push(id); save(); }
		let abandoned = false;
		pendingAreas.add(id);
		const creation = Promise.resolve().then(() => world.tickingAreaManager.createTickingArea(id, options));
		const tracked = creation.finally(() => {
			pendingAreas.delete(id);
			if (abandoned) {
				attempt(`Late cleanup of ${id}`, () => removeArea(id));
				if (!active && !recovering) attempt("Finishing late recovery", finishRecovery);
			}
		});
		let timeoutId;
		const timeout = new Promise(resolve => {
			timeoutId = system.runTimeout(() => resolve(new Error(`Loading ${id} timed out after ${LOAD_TIMEOUT} ticks`)), LOAD_TIMEOUT);
		});
		try {
			const outcome = await Promise.race([tracked, timeout, ...(job ? [job.cancellation] : [])]);
			if (outcome instanceof Error) throw outcome;
			if (job) check(job);
			if (!world.tickingAreaManager.getTickingArea(id)?.isFullyLoaded) throw new Error(`Ticking area is not fully loaded: ${id}`);
		} catch (error) {
			abandoned = true;
			throw error;
		} finally {
			system.clearRun(timeoutId);
			if (abandoned) attempt(`Cleaning ${id}`, () => removeArea(id));
		}
	}
	function areaOptions(dimension, minX, maxX, minZ, maxZ) {
		return {
			dimension,
			from: { x: minX, y: dimension.heightRange.min, z: minZ },
			to: { x: maxX, y: dimension.heightRange.max - 1, z: maxZ },
		};
	}
	function homeOptions() {
		const { location, dimensionId } = record.origin;
		return areaOptions(world.getDimension(dimensionId),
			Math.floor(location.x - 1), Math.floor(location.x + 1),
			Math.floor(location.z - 1), Math.floor(location.z + 1));
	}
	function repairBlock() {
		if (!record.pendingBlock) return true;
		const { dimensionId, location } = record.pendingBlock;
		const block = world.getDimension(dimensionId).getBlock(location);
		if (!block) throw new Error("Temporary block is not loaded; recovery retained");
		if (block.typeId === "minecraft:barrier") block.setPermutation(BlockPermutation.resolve("minecraft:air"));
		if (block.typeId !== "minecraft:air") throw new Error("Temporary block was changed externally; it was left untouched");
		record.pendingBlock = null;
		save();
		return true;
	}
	async function dirtyChunk(job, dimension, cx, cz) {
		let block;
		let reads = 0;
		// Normal overworld chunks use the first read, preserving the fast path.
		// A few full-height columns also cover caves beneath a solid Nether roof.
		for (const [dx, dz] of [[8, 8], [4, 4], [12, 12], [4, 12]]) {
			for (let y = dimension.heightRange.max - 1; y >= dimension.heightRange.min; y--) {
				check(job);
				const candidate = dimension.getBlock({ x: cx * CHUNK_SIZE + dx, y, z: cz * CHUNK_SIZE + dz });
				if (!candidate) throw new Error("Chunk is not loaded");
				if (candidate.typeId === "minecraft:air") { block = candidate; break; }
				if (++reads % 64 === 0) await pause(job);
			}
			if (block) break;
		}
		if (!block) throw new Error("No verified air in the sampled chunk columns; no block was changed");
		const original = block.permutation;
		record.pendingBlock = { dimensionId: dimension.id, location: { ...block.location } };
		save();
		try {
			if (block.typeId !== "minecraft:air") throw new Error("Air candidate changed before modification");
			barrier ??= BlockPermutation.resolve("minecraft:barrier");
			block.setPermutation(barrier);
			if (block.typeId !== "minecraft:barrier") throw new Error("Temporary block write could not be verified");
		} finally {
			// No await while a barrier is present. A failed restoration keeps the
			// write-ahead record and stops further chunk modifications.
			if (block.typeId === "minecraft:barrier") block.setPermutation(original);
			if (block.typeId !== "minecraft:air") throw new Error("Air restoration could not be verified");
			record.pendingBlock = null;
			save();
		}
	}
	function resetFlag(player) {
		if (!player?.isValid) return false;
		player.setDynamicProperty(GENERATING_PROPERTY, false);
		if (record?.playerId === player.id) { record.flagPending = false; save(); }
		return true;
	}
	function initialize() {
		if (ready) return;
		try {
			const raw = world.getDynamicProperty(RECOVERY_PROPERTY);
			if (raw !== undefined) {
				record = JSON.parse(raw);
				if (!validRecord(record)) {
					throw new Error("Unsupported recovery record; it was retained");
				}
				// Player data and script properties are not an atomic disk commit.
				// A saved return flag alone cannot prove the player was also saved home.
				if (record.travelStarted) record.returnPending = true;
			}
			if (record) attempt("Restoring interrupted temporary block", repairBlock);
		} catch (error) { storageError = error; logError("Initializing recovery", error); }
		if (!storageError) attempt("Inspecting stale ticking areas", () => {
			resourcesScanned = scanStaleAreas();
			if (record) save();
			else for (const player of world.getAllPlayers()) attempt("Resetting stale generation flag", () => resetFlag(player));
		});
		ready = true;
	}
	function scanStaleAreas() {
		// A transient resource query/removal error is retried, not treated as
		// corrupt saved data and not forgotten when there is no saved journal.
		const areas = attempt("Listing stale ticking areas", () => world.tickingAreaManager.getAllTickingAreas());
		if (!areas) return false;
		for (const area of areas) {
			if (!area.identifier.startsWith(AREA_PREFIX) && !area.identifier.startsWith("chunk_generator:section_")) continue;
			if (record && !record.areaIds.includes(area.identifier)) record.areaIds.push(area.identifier);
			else if (!record) staleAreas.add(area.identifier);
			attempt("Removing stale ticking area", () => removeArea(area.identifier));
		}
		return true;
	}
	async function recover(player) {
		initialize();
		if (active || recovering || storageError) return false;
		if (!record) { if (player) attempt("Resetting stale generation flag", () => resetFlag(player)); return true; }
		if (!player) player = attempt("Finding recovery player", onlinePlayer);
		if (player && player.id !== record.playerId) return false;
		recovering = true;
		try {
			if (player?.isValid && record.travelStarted && !record.returnPending) {
				const origin = record.origin;
				if (player.dimension.id !== origin.dimensionId || ["x", "y", "z"].some(axis => Math.abs(player.location[axis] - origin.location[axis]) > 0.05)) {
					record.returnPending = true;
					save();
				}
			}
			if (player?.isValid && record.returnPending) {
				attempt("Renewing recovery protection", () => protect(player));
				if (!attempt("Restoring original position", () => returnPlayer(player))) {
					const id = `${record.jobId}_home`;
					const options = homeOptions();
					if (!pendingAreas.has(id) && !world.tickingAreaManager.hasTickingArea(id) && world.tickingAreaManager.hasCapacity(options)) {
						await loadArea(id, options);
					}
					attempt("Restoring loaded original position", () => returnPlayer(player));
				}
			}
		} catch (error) { logError("Player recovery remains pending", error); }
		try {
			if (record.pendingBlock) {
				if (!attempt("Restoring temporary block", repairBlock)) {
					const { dimensionId, location } = record.pendingBlock;
					const id = `${record.jobId}_repair`;
					const options = areaOptions(world.getDimension(dimensionId), location.x, location.x, location.z, location.z);
					if (!pendingAreas.has(id) && !world.tickingAreaManager.hasTickingArea(id) && world.tickingAreaManager.hasCapacity(options)) await loadArea(id, options);
					attempt("Restoring loaded temporary block", repairBlock);
				}
			}
		} catch (error) { logError("Block recovery remains pending", error); }
		finally {
			if (player?.isValid && record) {
				if (!record.returnPending) await restoreAfterLanding(player);
				attempt("Resetting generation state", () => resetFlag(player));
			}
			removeAreas();
			attempt("Finishing recovery", finishRecovery);
			recovering = false;
		}
		return !record;
	}
	function tick() {
		if (!ready || storageError) return;
		if (!record) {
			if (system.currentTick % 100 === 0) {
				if (!resourcesScanned) resourcesScanned = scanStaleAreas();
				removeAreas();
			}
			return;
		}
		const player = active?.player ?? attempt("Finding recovery player", onlinePlayer);
		if (player?.isValid && (active || record.returnPending)) {
			try {
				protect(player);
				if (active) check(active);
				if (record.returnPending) {
					const dimension = player.dimension;
					const location = player.location;
					const velocity = player.getVelocity();
					const margin = Math.min(32, (dimension.heightRange.max - dimension.heightRange.min) / 4);
					if (dimension.id !== record.origin.dimensionId ||
						location.y <= dimension.heightRange.min + margin + Math.max(0, -velocity.y) * 4 ||
						!clearBody(dimension, location, false)) {
						throw new Error("Unsafe descent, obstruction, liquid, or unloaded player position");
					}
				}
			} catch (error) {
				if (active) cancel(active, `${error}`);
				else emergencyReturn(player);
			}
		} else if (active) cancel(active, "Player disconnected");
		if (!active && !recovering && system.currentTick % 100 === 0) void recover(player);
	}
	async function start(player, minChunkX, maxChunkX, minChunkZ, maxChunkZ) {
		initialize();
		if (!active && !recovering && !record && !storageError) {
			if (!resourcesScanned) resourcesScanned = scanStaleAreas();
			removeAreas();
		}
		if (active || recovering || record || pendingAreas.size || staleAreas.size || !resourcesScanned || storageError) {
			message(player, "§cAnother generation or a pending recovery is still in progress. The affected player must be online for recovery.");
			return { status: "refused" };
		}
		const bounds = [minChunkX, maxChunkX, minChunkZ, maxChunkZ];
		if (!bounds.every(Number.isSafeInteger) || minChunkX >= maxChunkX || minChunkZ >= maxChunkZ ||
			bounds.some(value => Math.abs(value * CHUNK_SIZE) > 29999984)) {
			message(player, "§cInvalid or empty selection, or coordinates outside supported world bounds.");
			return { status: "refused" };
		}
		const job = { player, reason: null };
		job.cancellation = new Promise(resolve => { job.resolveCancellation = resolve; });
		active = job; // Acquire the global lock before the first await.
		const total = (maxChunkX - minChunkX) * (maxChunkZ - minChunkZ);
		const sections = Math.ceil((maxChunkX - minChunkX) / SECTION_CHUNKS) * Math.ceil((maxChunkZ - minChunkZ) / SECTION_CHUNKS);
		const result = { status: "failed", total, processed: 0, successful: 0, partial: 0, failed: 0, cancelled: 0, notStarted: sections };
		try {
			if (!player.isValid || player.getGameMode() !== "Survival") throw new Error("Start generation in Survival mode");
			const dimension = player.dimension;
			const origin = { location: { ...player.location }, dimensionId: dimension.id, rotation: { ...player.getRotation() }, gameMode: player.getGameMode() };
			if (Math.abs(origin.location.y - Math.round(origin.location.y)) > 0.01 || !clearBody(dimension, origin.location, true)) {
				throw new Error("Stand on a supported full block with clear space around you before starting");
			}
			const effects = EFFECTS.map(spec => ({ ...spec, original: snapshotEffect(player, spec), owned: false }));
			for (const effect of effects) {
				if (effect.original && !adequate(effect.original, effect)) throw new Error(`Existing ${effect.typeId} is too weak or expires soon; it was left unchanged.`);
			}
			record = { version: 1, jobId: `${AREA_PREFIX}${Date.now().toString(36)}_${++sequence}`, playerId: player.id, playerName: player.name,
				origin, effects, returnPending: false, travelStarted: false, flagPending: true, areaIds: [], pendingBlock: null };
			save();
			player.setDynamicProperty(GENERATING_PROPERTY, true);
			protect(player);
			const homeId = `${record.jobId}_home`;
			const home = homeOptions();
			if (!world.tickingAreaManager.hasCapacity(home)) throw new Error("No ticking-area capacity for the return location");
			await loadArea(homeId, home, job);
			let index = 0;
			for (let cx = minChunkX; cx < maxChunkX && !job.reason; cx += SECTION_CHUNKS) {
				for (let cz = minChunkZ; cz < maxChunkZ && !job.reason; cz += SECTION_CHUNKS) {
					check(job);
					const endX = Math.min(cx + SECTION_CHUNKS, maxChunkX);
					const endZ = Math.min(cz + SECTION_CHUNKS, maxChunkZ);
					const expected = (endX - cx) * (endZ - cz);
					const before = result.processed;
					const id = `${record.jobId}_section_${++index}`;
					result.notStarted--;
					let interrupted = false;
					try {
						const options = areaOptions(dimension, cx * CHUNK_SIZE, endX * CHUNK_SIZE - 1, cz * CHUNK_SIZE, endZ * CHUNK_SIZE - 1);
						if (!world.tickingAreaManager.hasCapacity(options)) throw new Error("Insufficient ticking-area capacity");
						protect(player);
						record.returnPending = true;
						record.travelStarted = true;
						save();
						// Retain player proximity BEFORE creating the remote ticking area.
						// An above-build-volume target cannot contain terrain, even while
						// unloaded. Never substitute tryTeleport, which requires loading.
						teleport(player, { x: cx * CHUNK_SIZE, y: dimension.heightRange.max + 4, z: cz * CHUNK_SIZE }, dimension, origin.rotation, false);
						check(job);
						await loadArea(id, options, job);
						check(job);
						for (let x = cx; x < endX; x++) {
							for (let z = cz; z < endZ; z++) {
								check(job);
								try { await dirtyChunk(job, dimension, x, z); result.processed++; }
								catch (error) {
									if (error instanceof GenerationCancelled || record.pendingBlock) throw error;
									logError(`Chunk ${x},${z}`, error);
								}
							}
						}
					} catch (error) {
						interrupted = error instanceof GenerationCancelled;
						message(player, `§cSection ${index}/${sections}: ${error.message}`);
						logError(`Section ${index}/${sections}`, error);
						if (record.pendingBlock) cancel(job, "Temporary block restoration failed", "failed");
					} finally {
						attempt(`Cleaning section ${index}`, () => removeArea(id));
						if (!attempt("Returning after section", () => returnPlayer(player))) cancel(job, "Return failed; recovery retained", "failed");
					}
					const processed = result.processed - before;
					if (interrupted || job.status === "cancelled") result.cancelled++;
					else if (processed === expected) result.successful++;
					else if (processed > 0) result.partial++;
					else result.failed++;
					const progress = `Section ${index}/${sections}: ${processed}/${expected} chunks processed; total ${result.processed}/${total}.`;
					logger.log(`[Chunk Generator] ${progress}`);
					message(player, `§7${progress}`);
				}
			}
			result.status = job.reason ? job.status : result.processed === total ? "complete" : result.processed ? "partial" : "failed";
		} catch (error) {
			result.status = error instanceof GenerationCancelled ? "cancelled" : "failed";
			message(player, `§cGeneration stopped: ${error.message}`);
			logError("Generation stopped", error);
		} finally {
			if (record) {
				attempt("Restoring pending air block", repairBlock);
				const returned = attempt("Final return", () => returnPlayer(player));
				if (returned && player.isValid) {
					// Keep slow falling through a landing tick before removing our grant.
					await restoreAfterLanding(player);
				}
				attempt("Resetting generation state", () => resetFlag(player));
				removeAreas();
			}
			active = undefined;
			attempt("Finishing cleanup", finishRecovery);
			result.recoveryPending = !!record;
			if (result.recoveryPending && result.status === "complete") result.status = "recovery_pending";
			const summary = `Generation ${result.status}: ${result.processed}/${total} chunks processed. Sections: ${result.successful} successful, ${result.partial} partial, ${result.failed} failed, ${result.cancelled} canceled, ${result.notStarted} not started. Disk save is not verified.${record ? " Recovery remains pending." : ""}`;
			message(player, `${result.status === "complete" ? "§a" : "§e"}${summary}`);
			logger.log(`[Chunk Generator] ${summary}`);
		}
		return result;
	}
	function stop(player) {
		if (active?.player.id === player.id) cancel(active, "Canceled by player");
		else void recover(player);
	}
	function onLeave(playerId) {
		if (active?.player.id === playerId) cancel(active, "Player disconnected");
	}
	return { initialize, start, stop, recover, tick, onLeave, isGenerating: player => active?.player.id === player.id };
}
