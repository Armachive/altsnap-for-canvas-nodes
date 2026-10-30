# Altsnap for Canvas Nodes

obsidian canvas nodes resizing boundaries were too tiny so i vibed this to copy AltSnap functionality but just for the canvas nodes. it works for mobile.

Move and resize canvas groups and notes the way [AltSnap](https://github.com/RamonUnch/AltSnap) moves and resizes windows: hold Alt, then drag anywhere on the node. No hunting for tiny corner handles.

## How it works

- **Alt + right drag** resizes. The node is split into zones like AltSnap, so grabbing anywhere near a corner resizes that corner, and the center resizes in all directions (configurable).
- **Alt + left drag** moves. Groups take everything inside them along.
- **Notes first.** If the cursor is over a note, the note is grabbed. Otherwise the innermost group under the cursor is grabbed, so nested groups behave.
- **Selections.** With several nodes selected (box select or Shift click), Alt + drag inside the selection box moves or resizes the whole selection as one box. Everything inside scales with it. Outside the box, Alt + drag still grabs single nodes like normal.
- **Alignment snapping.** The edge you drag lines up with the matching edge of the nearest neighbour beside, above or below it. Only one direction snaps at a time, and only when very close. Hold Shift to toggle. Once snapped it holds steady until you pull clearly away.
- **Esc** cancels a drag. Every action can be undone.
- **Alt + click on empty canvas** is swallowed, so right drag panning only happens without Alt.

<img width="1476" height="936" alt="works as such" src="https://github.com/user-attachments/assets/26606d6a-dd09-4763-b41a-e1e66d66df6c" />


## Touch

- **Touch and drag** a note, group or selection to resize it from where you touched, using the same zones as the mouse.
- **Hold still, then drag** to move it instead. Holding never resizes.
- **Tap** works like normal, so you can still select and open nodes.
- **On/off button** in the canvas zoom controls pauses touch AltSnap so one finger pans again.
- A second finger cancels the drag so pinch zoom still works.
- No snapping on touch, so finger drags land exactly where you put them.


example of alt resizing the selection box itself aswell as multiple different node selections:
<img width="1569" height="986" alt="it works gi" src="https://github.com/user-attachments/assets/b096d1d5-731d-40bd-a8af-a7a7f0091467" />



## Settings

Most of AltSnap's own options that make sense on a canvas are here: hotkeys (left/right Alt, Ctrl, Shift, Win), two key combo, alternate action key, actions for all five mouse buttons plus alternate and double click actions, center and sides fractions, center resize mode, sticky resize, drag threshold, refresh/move/resize rates, opacity while dragging, cursor modes, and blacklists by group label or color.

## Notes

- Uses Obsidian's internal canvas API, which isn't officially documented. A future Obsidian update may need a plugin update.
- If you run AltSnap itself, it grabs Alt + drag before Obsidian sees it unless Obsidian is fullscreen or blacklisted in AltSnap.

## Credits

Resize zone logic is ported from [AltSnap](https://github.com/RamonUnch/AltSnap) by RamonUnch (GPL-3.0). This plugin is also GPL-3.0.
