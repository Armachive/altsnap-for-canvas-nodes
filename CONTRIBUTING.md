# Contributing

Bug reports and ideas are welcome. Please open an issue first so we can talk it through.

## Reporting a bug

Include:
- Obsidian version and platform (Windows, macOS, Linux, Android, iOS)
- Mouse, touch or both
- What you did, what you expected, what happened
- Any other canvas plugins you run (Advanced Canvas, etc)

## Code

- The plugin is plain JavaScript in `main.js`, no build step.
- Keep changes small and focused, one fix or feature per pull request.
- Only change node position and size through Obsidian's canvas API. Never write canvas files directly.
- Test on a throwaway canvas before opening a pull request.

## Releases

Bump `version` in `manifest.json`, add it to `versions.json`, then push a tag with the same version (e.g. `1.2.2`). The release workflow publishes the files with build attestations.

## License

By contributing you agree your work is released under GPL-3.0, the same as the rest of the plugin.
