import {
	world,
	system,
	CommandPermissionLevel,
	CustomCommandParamType,
	BlockPermutation
} from "@minecraft/server";
import {
	ActionFormData,
	ModalFormData,
	MessageFormData
} from "@minecraft/server-ui";

const CHUNK_SIZE = 16;
const HALF_CHUNK_SIZE = 8;
const SELECTION_PROPERTY = "chunk_generator:selection";
const GENERATING_PROPERTY = "chunk_generator:generating";

system.beforeEvents.startup.subscribe(
	(init) => {
		init.customCommandRegistry.registerCommand(
			{
				name: "chunk_generator:gui",
				description: "Generate Chunk GUI",
				permissionLevel: CommandPermissionLevel.Any,
			},
			(origin, args) => {
				const player = origin.sourceEntity;
				if (player && player.typeId === "minecraft:player") {
					system.run(() => {
						showMainMenu(player);
					});
				}
			}
		);
		init.customCommandRegistry.registerCommand(
			{
				name: "chunk_generator:generate",
				description: "Generate Chunks",
				permissionLevel: CommandPermissionLevel.Any,
				mandatoryParameters: [
					{ name: "min_x", type: CustomCommandParamType.Integer },
					{ name: "min_z", type: CustomCommandParamType.Integer },
					{ name: "max_x", type: CustomCommandParamType.Integer },
					{ name: "max_z", type: CustomCommandParamType.Integer },
				],
			},
			(origin, x1, z1, x2, z2) => {
				const player = origin.sourceEntity;
				if (player && player.typeId === "minecraft:player") {
					system.run(() => {
						const selection = {
							minX: Math.min(x1, x2),
							maxX: Math.max(x1, x2),
							minZ: Math.min(z1, z2),
							maxZ: Math.max(z1, z2),
						}
						const chunkSelection = getChunkSelection(selection);
						player.sendMessage(`${chunkSelection.minChunkX} ${chunkSelection.maxChunkX} ${chunkSelection.minChunkZ} ${chunkSelection.maxChunkZ} ${chunkSelection.chunkCount}`);
						startGeneration(
							player, 
							chunkSelection.minChunkX, 
							chunkSelection.maxChunkX, 
							chunkSelection.minChunkZ, 
							chunkSelection.maxChunkZ, 
							chunkSelection.chunkCount
						);
					});
				}
			}
		);
		init.customCommandRegistry.registerCommand(
			{
				name: "chunk_generator:radius",
				description: "Radius selection",
				permissionLevel: CommandPermissionLevel.Any,
				mandatoryParameters: [
					{ name: "radius", type: CustomCommandParamType.Integer },
				],
			},
			(origin, radius) => {
				const player = origin.sourceEntity;
				if (player && player.typeId === "minecraft:player") {
					system.run(() => {
						setRadius(player, radius);
					});
				}
			}
		);
		init.customCommandRegistry.registerCommand(
			{
				name: "chunk_generator:stop",
				description: "Stop Generating Chunks",
				permissionLevel: CommandPermissionLevel.Any,
			},
			(origin, args) => {
				const player = origin.sourceEntity;
				if (player && player.typeId === "minecraft:player") {
					system.run(() => {
						player.setDynamicProperty(GENERATING_PROPERTY, false);
					});
				}
			}
		);
	}
);

/** @returns {{minX:number,maxX:number,minZ:number,maxZ:number}|null} */
function getSelection(player) {
	const raw = player.getDynamicProperty(SELECTION_PROPERTY);
	if (typeof raw !== "string") return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function setSelection(player, selection) {
	player.setDynamicProperty(SELECTION_PROPERTY, JSON.stringify(selection));
}

function clearSelection(player) {
	player.setDynamicProperty(SELECTION_PROPERTY, null);
	showMainMenu(player);
}

function getChunkSelection(selection) {
	const minChunkX = Math.floor(selection.minX / CHUNK_SIZE);
	const maxChunkX = Math.ceil((selection.maxX) / CHUNK_SIZE);
	const minChunkZ = Math.floor(selection.minZ / CHUNK_SIZE);
	const maxChunkZ = Math.ceil((selection.maxZ) / CHUNK_SIZE);
	return {
		minChunkX: minChunkX,
		maxChunkX: maxChunkX,
		minChunkZ: minChunkZ,
		maxChunkZ: maxChunkZ,
		chunkCount: (maxChunkX - minChunkX) * (maxChunkZ - minChunkZ),
	};
}

function getSelectionText(selection) {
	const chunkSelection = getChunkSelection(selection);
	return `Current selection: ${chunkSelection.chunkCount} chunks
§7From:§r X=${selection.minX}, Z=${selection.minZ} §7To:§r X=${selection.maxX}, Z=${selection.maxZ}`;
}

function showMainMenu(player) {
	const selection = getSelection(player);
	const body = selection ? getSelectionText(selection) : "No Selection.";
	const generating = player.getDynamicProperty(GENERATING_PROPERTY);

	const form = new ActionFormData()
		.title("Chunk Generator")
		.body(body)
		.button("Set Coordinates")
		.button("Extend to My Position")
		.button("Clear Selection")
		.button(generating ? "Cancel" : "Generate");

	form.show(player).then((response) => {
		if (response.canceled || response.selection === undefined) return;
		if (response.selection === 0) showEditForm(player);
		else if (response.selection === 1) extendToPlayer(player);
		else if (response.selection === 2) clearSelection(player);
		else if (response.selection === 3) {
			if (generating) {
				player.setDynamicProperty(GENERATING_PROPERTY, false);
			} else {
				confirmAndGenerate(player);
			}
		}
	});
}

function showEditForm(player) {
	const selection = getSelection(player) ?? {
		minX: 0,
		maxX: 0,
		minZ: 0,
		maxZ: 0
	};

	const form = new ModalFormData()
		.title("Set Selection Coordinates")
		.textField("Min X", "e.g. -128", {
			defaultValue: selection.minX.toString()
		})
		.textField("Max X", "e.g. 128", {
			defaultValue: selection.maxX.toString()
		})
		.textField("Min Z", "e.g. -128", {
			defaultValue: selection.minZ.toString()
		})
		.textField("Max Z", "e.g. 128", {
			defaultValue: selection.maxZ.toString()
		});

	form.show(player).then((response) => {
		if (response.canceled || !response.formValues) {
			showMainMenu(player);
			return;
		}
		const [minXStr, maxXStr, minZStr, maxZStr] = response.formValues;
		const minX = parseInt(String(minXStr), 10);
		const maxX = parseInt(String(maxXStr), 10);
		const minZ = parseInt(String(minZStr), 10);
		const maxZ = parseInt(String(maxZStr), 10);

		if ([minX, maxX, minZ, maxZ].some((n) => !Number.isFinite(n))) {
			player.sendMessage("§cAll four fields must be whole numbers.");
			showEditForm(player);
			return;
		}

		setSelection(player, {
			minX: Math.min(minX, maxX),
			maxX: Math.max(minX, maxX),
			minZ: Math.min(minZ, maxZ),
			maxZ: Math.max(minZ, maxZ),
		});
		player.sendMessage("§aSelection updated.");
		showMainMenu(player);
	});
}

function setRadius(player, radius){
	const loc = player.location;
	const selection = {
		minX: loc.x - radius / 2,
		maxX: loc.x + radius / 2,
		minZ: loc.z - radius / 2,
		maxZ: loc.z + radius / 2,
	};

	setSelection(player, selection);
	player.sendMessage(`§aSelection set be a radius ${radius} around (${loc.x}, ${loc.z}).`);
	showMainMenu(player);
}

function extendToPlayer(player) {
	const loc = player.location;
	const x = Math.floor(loc.x);
	const z = Math.floor(loc.z);
	const selection = getSelection(player);

	const updated = selection ?
		{
			minX: Math.min(selection.minX, x),
			maxX: Math.max(selection.maxX, x + 1),
			minZ: Math.min(selection.minZ, z),
			maxZ: Math.max(selection.maxZ, z + 1),
		} :
		{
			minX: x,
			maxX: x + 1,
			minZ: z,
			maxZ: z + 1
		};

	setSelection(player, updated);
	player.sendMessage(`§aSelection extended to include (${x}, ${z}).`);
	showMainMenu(player);
}

function confirmAndGenerate(player) {
	const selection = getSelection(player);
	if (!selection) {
		player.sendMessage("§cCreate a selection first.");
		showMainMenu(player);
		return;
	}

	const chunkSelection = getChunkSelection(selection);

	const form = new MessageFormData()
		.title("Confirm Generation")
		.body(`This will generate and save ${chunkSelection.chunkCount} chunk(s). It may take a while.`)
		.button1("Start")
		.button2("Cancel");

	form.show(player).then((response) => {
		if (response.canceled || response.selection === 1) {
			showMainMenu(player);
			return;
		}
		startGeneration(player, chunkSelection.minChunkX, chunkSelection.maxChunkX, chunkSelection.minChunkZ, chunkSelection.maxChunkZ, chunkSelection.chunkCount);
	});
}

const SECTION_CHUNKS = 8; // process the selection in 8x8-chunk sections

/**
 * Splits the chunk range into SECTION_CHUNKS x SECTION_CHUNKS sections. For
 * each one, opens a ticking area (which forces those chunks to load and
 * simulate with no player nearby), waits for confirmation they're actually
 * loaded, dirties a block in each chunk so it gets picked up by the next
 * autosave, then tears the ticking area down before moving to the next
 * section — keeping us well under the manager's chunk-capacity limit.
 */
async function startGeneration(player, minChunkX, maxChunkX, minChunkZ, maxChunkZ, total) {
	const dimension = player.dimension;
	const manager = world.tickingAreaManager;
	const minY = dimension.heightRange.min;
	const maxY = dimension.heightRange.max;
	const BARRIER = BlockPermutation.resolve("minecraft:barrier");
	
	let chunks_generated = 0;
	let sections_generated = 0;
	let sectionCount = Math.ceil((maxChunkX - minChunkX)/SECTION_CHUNKS) * Math.ceil((maxChunkZ - minChunkZ)/SECTION_CHUNKS);

	const old_player_loc = player.location;
	
	player.setDynamicProperty(GENERATING_PROPERTY, true);
	
	for (let section_cx_min = minChunkX; section_cx_min < maxChunkX; section_cx_min += SECTION_CHUNKS) {
		console.log(`section_cx_min: ${section_cx_min}`);
		const section_cx_max = Math.min(section_cx_min + SECTION_CHUNKS, maxChunkX);
		
		for (let section_cz_min = minChunkZ; section_cz_min < maxChunkZ; section_cz_min += SECTION_CHUNKS) {
			console.log(`section_cz_min: ${section_cz_min}`);
			const section_cz_max = Math.min(section_cz_min + SECTION_CHUNKS, maxChunkZ);
			
			if (!player.isValid) {
				console.warn("player is invalid!");
				return;
			}
			
			if (!player.getDynamicProperty(GENERATING_PROPERTY)) {
				player.sendMessage(`§aGeneration canceled: ${chunks_generated}/${total} chunks processed.`);
				return;
			}
			
			sections_generated++;
			const tickingAreaId = `chunk_generator:section_${sections_generated}`;
			const options = {
				dimension,
				from: {
					x: section_cx_min * CHUNK_SIZE,
					y: minY,
					z: section_cz_min * CHUNK_SIZE
				},
				to: {
					x: section_cx_max * CHUNK_SIZE - 1,
					y: maxY,
					z: section_cz_max * CHUNK_SIZE - 1
				},
			};
			player.teleport({
				x: section_cx_min * CHUNK_SIZE,
				y: 200,
				z: section_cz_min * CHUNK_SIZE
			});

			if (!manager.hasCapacity(options)) {
				player.sendMessage(`§cSection ${sections_generated}/${sectionCount} is too large for the ticking-area budget — skipped.`);
				continue;
			}

			try {
				console.log("creating ticking area...");
				await manager.createTickingArea(tickingAreaId, options);
				console.log("creating ticking area... ok");
			} catch (e) {
				player.sendMessage(`§cCouldn't load section ${sections_generated}/${sectionCount}: ${e}`);
				continue;
			}

			for (let x = section_cx_min; x < section_cx_max; x++) {
				console.log(`x: ${x}`);
				for (let z = section_cz_min; z < section_cz_max; z++) {
					console.log(`z: ${z}`);
					const block = dimension.getBlock({
						x: x * CHUNK_SIZE + HALF_CHUNK_SIZE,
						y: maxY - 1,
						z: z * CHUNK_SIZE + HALF_CHUNK_SIZE
					});
					if (block === undefined){
						player.sendMessage(`§cChunk at x=${x * CHUNK_SIZE}, cz=/${z * CHUNK_SIZE} was not loaded`);
						continue;
					}
					const original = block.permutation;
					block.setPermutation(BARRIER);
					block.setPermutation(original);
					chunks_generated++;
				}
			}

			console.log("removing ticking area...");
			manager.removeTickingArea(tickingAreaId);
			console.log("removing ticking area... ok");
			player.teleport(old_player_loc);
			player.sendMessage(`§7Section ${sections_generated}/${sectionCount} done — ${chunks_generated}/${total} chunks so far.`);
		}
	}
	
	player.setDynamicProperty(GENERATING_PROPERTY, false);

	player.sendMessage(`§aGeneration complete: ${chunks_generated}/${total} chunks processed.`);
}
