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
import { createGenerator } from "./generation.js";

const CHUNK_SIZE = 16;
const SELECTION_PROPERTY = "chunk_generator:selection";
const generator = createGenerator({ world, system, BlockPermutation });

world.afterEvents.worldLoad.subscribe(() => {
	generator.initialize();
	void generator.recover();
});
world.afterEvents.playerSpawn.subscribe(({ player }) => {
	system.run(() => { void generator.recover(player); });
});
world.afterEvents.playerLeave.subscribe(({ playerId }) => generator.onLeave(playerId));
system.runInterval(() => generator.tick(), 1);

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
						generator.stop(player);
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
	const generating = generator.isGenerating(player);

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
			if (generator.isGenerating(player)) {
				generator.stop(player);
			} else {
				confirmAndGenerate(player);
			}
		}
	}).catch(error => console.warn(`[Chunk Generator] Main menu: ${error}`));
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
	}).catch(error => console.warn(`[Chunk Generator] Coordinate form: ${error}`));
}

function setRadius(player, radius){
	if (!Number.isSafeInteger(radius) || radius <= 0) {
		player.sendMessage("§cRadius must be a positive whole number.");
		return;
	}
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
		.body(`This will process ${chunkSelection.chunkCount} chunk(s) for saving. It may take a while. The server saves the world separately.`)
		.button1("Start")
		.button2("Cancel");

	form.show(player).then((response) => {
		if (response.canceled || response.selection === 1) {
			showMainMenu(player);
			return;
		}
		startGeneration(player, chunkSelection.minChunkX, chunkSelection.maxChunkX, chunkSelection.minChunkZ, chunkSelection.maxChunkZ, chunkSelection.chunkCount);
	}).catch(error => console.warn(`[Chunk Generator] Generation confirmation: ${error}`));
}

function startGeneration(player, minChunkX, maxChunkX, minChunkZ, maxChunkZ) {
	return generator.start(player, minChunkX, maxChunkX, minChunkZ, maxChunkZ);
}
