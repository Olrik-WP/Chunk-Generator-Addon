# Project instructions

## Repository and documentation

- Work in this local fork: `https://github.com/Olrik-WP/Chunk-Generator-Addon`.
- The project is based on the aceinetx fork of Amulet Team's original addon. Keep both upstream links and the original documentation in README.md.
- Write README.md in English. Keep the fork's additions concise; do not add deployment checklists or lengthy testing procedures to it.

## Runtime constraints

- Target BDS 1.26.66.1 with stable APIs and Beta APIs disabled. Keep the existing API dependencies unless a change is necessary and explained.
- Preserve the pack name and UUIDs. Preserve all four commands, the GUI, 8 x 8 sections, and player proximity before remote ticking-area creation.
- Keep the player in Survival. Do not change game rules, inventory, or permanent player attributes. Preserve preexisting effects.
- Remote terrain loading must not require descending to the ground. Keep the player protected above the block volume while sections load and are processed.
- Do not confuse unloaded terrain or lava beneath a hovering player with a direct hazard. Correct recoverable displacement; stop and return safely if protection or relocation fails.
- Keep persistent recovery and independent cleanup. Never discard a journal while return, effects, a temporary block, an area, or an outstanding creation still needs recovery.
- Modify only verified air temporarily, restore it immediately, and count a chunk only after restoration has been verified.

## Verification and releases

- Reproduce reported failures with meaningful regression tests, including tick timing, section transitions, motion, and pending asynchronous operations. Automated simulations do not prove Minecraft physics or disk persistence.
- Logs must identify the actual condition, phase, position and relevant block or resource. Avoid catch-all danger messages, repeated coordinate spam, and claims of verified disk saves.
- Run the relevant tests, JavaScript syntax checks, and generate.ps1. Verify the archive matches src/, the UUIDs and dependencies are unchanged, and the intended pack/module versions agree.
- For an authorized release, increment the patch version consistently in the manifest, modules, package.json, builder, README and output filename.
- Keep only the current versioned .mcpack in the repository. Remove superseded packs only after the replacement has been built and verified. Do not rewrite Git history for routine cleanup.
- When the user has requested commit and push, finish the release, README update and old-pack cleanup, then commit and push to the existing branch on their fork. Check synchronization and report remaining real-BDS validation honestly.
